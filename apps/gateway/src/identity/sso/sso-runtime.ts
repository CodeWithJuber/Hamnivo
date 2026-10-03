import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  OIDCConfig,
  SSOProvider,
  SSOUserResolution,
  SSOUserResolutionContext,
  SSOUserResolutionInput,
} from '@better-auth/sso';
import {
  appendAudit,
  type Db,
  resolveSsoDomain,
  resolveSsoProvider,
  type SsoResolution,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { checkDelegation, type Grant, rolePatterns, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { isUniqueViolation } from '../../common/pg-error.js';
import { SecretBroker } from '../../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock } from '../../tokens.js';
import { scopeFromRow } from '../principal.service.js';

/** A connection Better Auth may use during this request, with what Hamnivo needs to decide. */
interface ResolvedConnection {
  tenantId: string;
  connectionId: string;
  providerId: string;
  domain: string;
}

interface SsoRequestContext {
  providers: DefaultProvider[];
  connection: ResolvedConnection | null;
}

/** The shape of `defaultSSO` entries in the SSO plugin options. */
export interface DefaultProvider {
  domain: string;
  providerId: string;
  oidcConfig: OIDCConfig;
}

type ProvisionInput = {
  user: { id: string; email: string; name: string };
  provider: Pick<SSOProvider<Record<string, never>>, 'providerId'>;
};

const SIGN_IN_PATH = '/api/auth/sign-in/sso';
const CALLBACK_PREFIX = '/api/auth/sso/callback/';

export const emailDomain = (email: string) => email.trim().toLowerCase().split('@')[1] ?? '';

function claimTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Single sign-on per tenant (A13), wired into Better Auth's SSO plugin without its own provider
 * storage: for the two SSO requests (starting a sign-in, and the provider's callback) this finds
 * the tenant's connection through the pre-tenant resolvers, reads the client secret from the
 * secret broker, and hands exactly that one provider to Better Auth for the request. The secret is
 * never stored anywhere else. It also decides who an SSO identity is (never linked to an
 * existing account by an unverified email), provisions just-in-time members, and says which
 * email domains must use SSO.
 */
@Injectable()
export class SsoRuntime {
  private readonly logger = new Logger(SsoRuntime.name);
  private readonly storage = new AsyncLocalStorage<SsoRequestContext>();

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly broker: SecretBroker,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The providers Better Auth sees during the current request (the `defaultSSO` option). */
  providers(): DefaultProvider[] {
    return this.storage.getStore()?.providers ?? [];
  }

  /** Runs a Better Auth request with the SSO connection it concerns, if any. */
  async run<T>(pathname: string, body: string | undefined, handle: () => Promise<T>): Promise<T> {
    let context: SsoRequestContext = { providers: [], connection: null };
    try {
      if (pathname === SIGN_IN_PATH) {
        context = await this.forSignIn(body);
      } else if (pathname.startsWith(CALLBACK_PREFIX)) {
        const providerId = decodeURIComponent(pathname.slice(CALLBACK_PREFIX.length));
        context = await this.load(await resolveSsoProvider(this.db, providerId), providerId);
      }
    } catch (error) {
      // Better Auth answers "no provider" for the request; nothing about the tenant leaks.
      this.logger.warn(`SSO connection could not be loaded: ${String(error)}`);
      context = { providers: [], connection: null };
    }
    return this.storage.run(context, handle);
  }

  private async forSignIn(body: string | undefined): Promise<SsoRequestContext> {
    let parsed: { email?: unknown; domain?: unknown; providerId?: unknown } = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return { providers: [], connection: null };
    }
    if (typeof parsed.providerId === 'string' && parsed.providerId) {
      return this.load(await resolveSsoProvider(this.db, parsed.providerId), parsed.providerId);
    }
    const domain =
      typeof parsed.domain === 'string' && parsed.domain
        ? parsed.domain.trim().toLowerCase()
        : typeof parsed.email === 'string'
          ? emailDomain(parsed.email)
          : '';
    if (!domain) return { providers: [], connection: null };
    const resolved = await resolveSsoDomain(this.db, domain);
    return this.load(resolved, resolved?.providerId ?? '');
  }

  private async load(
    resolved: SsoResolution | null,
    providerId: string,
  ): Promise<SsoRequestContext> {
    if (
      resolved?.connectionStatus !== 'active' ||
      resolved.tenantStatus !== 'active' ||
      !providerId
    ) {
      return { providers: [], connection: null };
    }
    return withTenant(
      this.db,
      { tenantId: resolved.tenantId, actorId: `sso:${providerId}` },
      async (tx) => {
        const [row] = await tx
          .select({ connection: schema.ssoConnections, domain: schema.ssoDomains.domain })
          .from(schema.ssoConnections)
          .innerJoin(schema.ssoDomains, eq(schema.ssoDomains.id, schema.ssoConnections.domainId))
          .where(eq(schema.ssoConnections.id, resolved.connectionId));
        if (row?.connection.status !== 'active' || row.connection.providerId !== providerId) {
          return { providers: [], connection: null };
        }
        const { connection } = row;
        const clientSecret = await this.broker.reveal(
          tx,
          resolved.tenantId,
          connection.clientSecretId,
        );
        const issuer = connection.issuer;
        return {
          providers: [
            {
              domain: row.domain,
              providerId: connection.providerId,
              oidcConfig: {
                issuer,
                pkce: true,
                clientId: connection.clientId,
                clientSecret,
                discoveryEndpoint: `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
                authorizationEndpoint: connection.authorizationEndpoint,
                tokenEndpoint: connection.tokenEndpoint,
                jwksEndpoint: connection.jwksEndpoint,
                ...(connection.userInfoEndpoint
                  ? { userInfoEndpoint: connection.userInfoEndpoint }
                  : {}),
                tokenEndpointAuthentication: connection.tokenEndpointAuth,
                scopes: connection.scopes,
              },
            },
          ],
          connection: {
            tenantId: resolved.tenantId,
            connectionId: connection.id,
            providerId: connection.providerId,
            domain: row.domain,
          },
        };
      },
    );
  }

  /** Records a refused SSO sign-in in the tenant's audit log (never the person's claims). */
  private async refuse(
    connection: ResolvedConnection | null,
    code: string,
    message: string,
  ): Promise<SSOUserResolution> {
    if (connection) {
      await withTenant(
        this.db,
        { tenantId: connection.tenantId, actorId: `sso:${connection.providerId}` },
        (tx) =>
          appendAudit(tx, {
            actorType: 'system',
            actorId: `sso:${connection.providerId}`,
            action: 'sso.sign_in_refused',
            targetType: 'sso_connection',
            targetId: toPublicId('ssoConnection', connection.connectionId),
            outcome: 'denied',
            data: { code, domain: connection.domain },
          }),
      ).catch((error) => this.logger.warn(`audit of a refused SSO sign-in failed: ${error}`));
    }
    return { action: 'reject', code, message };
  }

  /**
   * Who a verified provider identity is (Better Auth `resolveUser`). The address must be one the
   * provider verified, inside the domain this tenant proved. An existing account is linked only
   * when its own address was verified too; nothing is ever linked by an unverified email.
   */
  async resolveUser(
    input: SSOUserResolutionInput,
    context: SSOUserResolutionContext,
  ): Promise<SSOUserResolution> {
    const connection = this.storage.getStore()?.connection ?? null;
    if (!connection || connection.providerId !== input.providerId || input.protocol !== 'oidc') {
      return this.refuse(connection, 'sso_unavailable', 'Single sign-on is not available.');
    }
    const email = input.providerUser.email.trim().toLowerCase();
    const verified =
      claimTrue(input.verifiedIdTokenClaims.email_verified) ||
      (input.verifiedIdTokenClaims.email_verified === undefined &&
        claimTrue(input.providerClaims.email_verified));
    if (!verified) {
      return this.refuse(
        connection,
        'sso_email_unverified',
        'Your identity provider has not verified your email address.',
      );
    }
    if (emailDomain(email) !== connection.domain) {
      return this.refuse(
        connection,
        'sso_domain_mismatch',
        'This identity provider can only sign in addresses in the domain it serves.',
      );
    }
    const bound = await context.database.findOne<{ userId: string }>({
      model: 'account',
      where: [
        { field: 'providerId', value: input.providerId },
        { field: 'accountId', value: input.accountKey.accountId },
      ],
    });
    if (bound) return { action: 'continue' };
    const existing = await context.database.findOne<{ id: string; emailVerified: boolean }>({
      model: 'user',
      where: [{ field: 'email', value: email }],
    });
    if (!existing) return { action: 'continue' };
    if (!existing.emailVerified) {
      return this.refuse(
        connection,
        'sso_unverified_local_account',
        'An account with this address exists but its address was never confirmed. Confirm it first, then sign in with SSO.',
      );
    }
    return { action: 'link', userId: existing.id, profile: 'preserve' };
  }

  /**
   * Just-in-time membership (A13): a first SSO sign-in joins the tenant with the chosen role, as
   * delegated by the person who chose it, and only while that person still holds the role's
   * access (A03). Someone who was ever a member (suspended or removed included) is left alone;
   * only a new invitation brings them back.
   */
  async provisionUser(data: ProvisionInput): Promise<void> {
    const connection = this.storage.getStore()?.connection;
    if (!connection || data.provider.providerId !== connection.providerId) return;
    const actorId = `sso:${connection.providerId}`;
    try {
      await withTenant(this.db, { tenantId: connection.tenantId, actorId }, async (tx) => {
        const [current] = await tx
          .select()
          .from(schema.ssoConnections)
          .where(eq(schema.ssoConnections.id, connection.connectionId));
        if (current?.status !== 'active' || !current.jitRoleId || !current.jitGrantedBy) return;
        const [existing] = await tx
          .select({ id: schema.staffMembers.id })
          .from(schema.staffMembers)
          .where(eq(schema.staffMembers.authUserId, data.user.id));
        if (existing) return;
        const [role] = await tx
          .select()
          .from(schema.roleDefinitions)
          .where(
            and(
              eq(schema.roleDefinitions.id, current.jitRoleId),
              isNull(schema.roleDefinitions.archivedAt),
            ),
          );
        const delegator = await this.delegator(tx, current.jitGrantedBy);
        const problems =
          role && delegator
            ? checkDelegation(
                delegator,
                {
                  granteeStaffMemberId: `sso:${data.user.id}`,
                  permissions: rolePatterns(role),
                  scope: { type: 'tenant' },
                  expiresAt: null,
                },
                () => ({}),
                this.clock(),
              )
            : [{ code: 'not_allowed' as const, detail: 'no_grant' as const }];
        if (!role || problems.length > 0) {
          await appendAudit(tx, {
            actorType: 'system',
            actorId,
            action: 'member.sso_join_skipped',
            targetType: 'sso_connection',
            targetId: toPublicId('ssoConnection', current.id),
            outcome: 'denied',
            reason: 'The role for new members is no longer within the access of who chose it.',
            data: { problems: problems.map((p) => p.code) },
          });
          return;
        }
        const [member] = await tx
          .insert(schema.staffMembers)
          .values({
            tenantId: connection.tenantId,
            authUserId: data.user.id,
            displayName: data.user.name || data.user.email,
            email: data.user.email,
            status: 'active',
          })
          .returning({ id: schema.staffMembers.id });
        if (!member) throw new Error('staff member not returned');
        await tx.insert(schema.grants).values({
          tenantId: connection.tenantId,
          staffMemberId: member.id,
          roleId: role.id,
          scopeType: 'tenant',
          delegatedBy: current.jitGrantedBy,
          reason: 'Joined through single sign-on',
        });
        await appendAudit(tx, {
          actorType: 'system',
          actorId,
          action: 'member.joined_by_sso',
          targetType: 'staff',
          targetId: toPublicId('staff', member.id),
          outcome: 'success',
          data: {
            role: role.key,
            connection: toPublicId('ssoConnection', current.id),
            domain: connection.domain,
          },
        });
      });
    } catch (error) {
      // Two first sign-ins at once: the other one created the membership.
      if (isUniqueViolation(error, 'staff_members_auth_user_key')) return;
      this.logger.error(`just-in-time membership failed: ${String(error)}`);
    }
  }

  private async delegator(tx: TenantTx, staffMemberId: string): Promise<StaffPrincipal | null> {
    const [member] = await tx
      .select()
      .from(schema.staffMembers)
      .where(eq(schema.staffMembers.id, staffMemberId));
    if (member?.status !== 'active') return null;
    const rows = await tx
      .select({ grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(and(eq(schema.grants.staffMemberId, staffMemberId), isNull(schema.grants.revokedAt)));
    const grants: Grant[] = rows.map(({ grant, role }) => ({
      id: grant.id,
      permissions: rolePatterns(role),
      scope: scopeFromRow(grant.scopeType, grant.scopeId),
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
    }));
    return {
      kind: 'staff',
      tenantId: member.tenantId,
      staffMemberId,
      status: 'active',
      // The choice was made with a fresh, verified sign-in; the ceiling is what counts here.
      mfa: true,
      authenticatedAt: this.clock(),
      grants,
    };
  }

  /** Whether people with this address must sign in with single sign-on. */
  async ssoRequired(email: string): Promise<boolean> {
    const domain = emailDomain(email);
    if (!domain) return false;
    const resolved = await resolveSsoDomain(this.db, domain);
    return Boolean(
      resolved?.ssoOnly &&
        resolved.connectionStatus === 'active' &&
        resolved.tenantStatus === 'active',
    );
  }
}
