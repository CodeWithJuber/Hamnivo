import { randomBytes } from 'node:crypto';
import type {
  AddSsoDomainRequest,
  CreateSsoConnectionRequest,
  SsoConnection,
  SsoDomain,
  SsoSettings,
  UpdateSsoConnectionRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  checkDelegation,
  expandPatterns,
  PERMISSIONS,
  rolePatterns,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { delegationError } from '../../admin/delegation-errors.js';
import { AppError } from '../../common/app-error.js';
import type { OutboundPolicy } from '../../common/outbound.js';
import { isUniqueViolation } from '../../common/pg-error.js';
import { iso } from '../../common/views.js';
import type { AppConfig } from '../../config.js';
import { SecretBroker } from '../../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { DiscoveryProblem, discoverOidc } from './discovery.js';
import {
  checkVerificationRecord,
  DNS_RESOLVER,
  type DnsResolver,
  verificationRecord,
} from './dns.js';

type DomainRow = typeof schema.ssoDomains.$inferSelect;
type ConnectionRow = typeof schema.ssoConnections.$inferSelect;

export const OUTBOUND_POLICY = Symbol('OUTBOUND_POLICY');

function parseId(kind: 'ssoDomain' | 'ssoConnection' | 'role', publicId: string): string {
  try {
    return fromPublicId(kind, publicId);
  } catch (error) {
    if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
    throw error;
  }
}

function domainView(row: DomainRow): SsoDomain {
  return {
    id: toPublicId('ssoDomain', row.id),
    domain: row.domain,
    status: row.verifiedAt ? 'verified' : 'pending',
    verification: verificationRecord(row.domain, row.verificationToken),
    verifiedAt: iso(row.verifiedAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    lastCheckResult: (row.lastCheckResult as SsoDomain['lastCheckResult']) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Enterprise sign-in settings (A13): prove an email domain with DNS, connect an OpenID Connect
 * provider to it, require SSO for the domain, and choose the role for just-in-time membership.
 * The client secret goes to the secret broker and never comes back. Every change is audited.
 */
@Injectable()
export class SsoService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(DNS_RESOLVER) private readonly dns: DnsResolver,
    @Inject(OUTBOUND_POLICY) private readonly outbound: OutboundPolicy,
    private readonly broker: SecretBroker,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    entry: Omit<Parameters<typeof appendAudit>[1], 'actorType' | 'actorId' | 'outcome'> & {
      outcome?: 'success' | 'failed' | 'denied';
    },
  ) {
    return appendAudit(tx, {
      outcome: 'success',
      ...entry,
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
    });
  }

  callbackUrl(providerId: string): string {
    return `${this.config.PUBLIC_API_ORIGIN.replace(/\/$/, '')}/api/auth/sso/callback/${providerId}`;
  }

  private async connectionView(tx: TenantTx, row: ConnectionRow): Promise<SsoConnection> {
    const [domain] = await tx
      .select({ domain: schema.ssoDomains.domain })
      .from(schema.ssoDomains)
      .where(eq(schema.ssoDomains.id, row.domainId));
    const [role] = row.jitRoleId
      ? await tx
          .select()
          .from(schema.roleDefinitions)
          .where(eq(schema.roleDefinitions.id, row.jitRoleId))
      : [];
    return {
      id: toPublicId('ssoConnection', row.id),
      domainId: toPublicId('ssoDomain', row.domainId),
      domain: domain?.domain ?? '',
      protocol: 'oidc',
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecret: await this.broker.maskedIn(tx, row.clientSecretId),
      endpoints: {
        authorization: row.authorizationEndpoint,
        token: row.tokenEndpoint,
        jwks: row.jwksEndpoint,
        userInfo: row.userInfoEndpoint,
      },
      scopes: row.scopes,
      status: row.status,
      ssoOnly: row.ssoOnly,
      jitRole: role ? { id: toPublicId('role', role.id), key: role.key, name: role.name } : null,
      callbackUrl: this.callbackUrl(row.providerId),
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async settings(principal: StaffPrincipal): Promise<SsoSettings> {
    return this.tx(principal, async (tx) => {
      const domains = await tx
        .select()
        .from(schema.ssoDomains)
        .orderBy(asc(schema.ssoDomains.domain));
      const connections = await tx
        .select()
        .from(schema.ssoConnections)
        .orderBy(asc(schema.ssoConnections.createdAt));
      return {
        domains: domains.map(domainView),
        connections: await Promise.all(connections.map((row) => this.connectionView(tx, row))),
      };
    });
  }

  // ── Domains ────────────────────────────────────────────────────────────────────────────────

  async addDomain(
    principal: StaffPrincipal,
    input: z.output<typeof AddSsoDomainRequest>,
  ): Promise<SsoDomain> {
    try {
      return await this.tx(principal, async (tx) => {
        const [row] = await tx
          .insert(schema.ssoDomains)
          .values({
            tenantId: principal.tenantId,
            domain: input.domain,
            verificationToken: randomBytes(24).toString('base64url'),
            createdBy: principal.staffMemberId,
          })
          .returning();
        if (!row) throw new Error('domain not returned');
        await this.audit(tx, principal, {
          action: 'sso.domain_added',
          targetType: 'sso_domain',
          targetId: toPublicId('ssoDomain', row.id),
          data: { domain: row.domain },
        });
        return domainView(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'sso_domains_domain_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'domain', message: 'This domain is already listed.' }],
        });
      }
      throw error;
    }
  }

  /**
   * Looks for the TXT record now. Only one workspace may hold a domain verified: if another one
   * already proved it, this check fails, whatever this workspace publishes.
   */
  async verifyDomain(principal: StaffPrincipal, publicId: string): Promise<SsoDomain> {
    const domainId = parseId('ssoDomain', publicId);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.ssoDomains)
        .where(eq(schema.ssoDomains.id, domainId))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      if (row.verifiedAt) return domainView(row);
      let result: NonNullable<SsoDomain['lastCheckResult']> = await checkVerificationRecord(
        this.dns,
        row.domain,
        row.verificationToken,
      );
      const now = this.clock();
      if (result === 'verified') {
        try {
          await tx.transaction((savepoint) =>
            savepoint
              .update(schema.ssoDomains)
              .set({ verifiedAt: now })
              .where(eq(schema.ssoDomains.id, domainId)),
          );
        } catch (error) {
          if (!isUniqueViolation(error, 'sso_domains_verified_key')) throw error;
          result = 'claimed_elsewhere';
        }
      }
      const [updated] = await tx
        .update(schema.ssoDomains)
        .set({ lastCheckedAt: now, lastCheckResult: result })
        .where(eq(schema.ssoDomains.id, domainId))
        .returning();
      if (!updated) throw new Error('domain not returned');
      await this.audit(tx, principal, {
        action: result === 'verified' ? 'sso.domain_verified' : 'sso.domain_check_failed',
        outcome: result === 'verified' ? 'success' : 'failed',
        targetType: 'sso_domain',
        targetId: publicId,
        data: { domain: row.domain, result },
      });
      return domainView(updated);
    });
  }

  async removeDomain(principal: StaffPrincipal, publicId: string): Promise<void> {
    const domainId = parseId('ssoDomain', publicId);
    await this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.ssoDomains)
        .where(eq(schema.ssoDomains.id, domainId))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      const [connection] = await tx
        .select({ id: schema.ssoConnections.id })
        .from(schema.ssoConnections)
        .where(eq(schema.ssoConnections.domainId, domainId));
      if (connection) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Remove the single sign-on connection for this domain first.',
        });
      }
      await tx.delete(schema.ssoDomains).where(eq(schema.ssoDomains.id, domainId));
      await this.audit(tx, principal, {
        action: 'sso.domain_removed',
        targetType: 'sso_domain',
        targetId: publicId,
        data: { domain: row.domain, wasVerified: Boolean(row.verifiedAt) },
      });
    });
  }

  // ── Connections ────────────────────────────────────────────────────────────────────────────

  private async discover(issuer: string) {
    try {
      return await discoverOidc(issuer, this.outbound);
    } catch (error) {
      if (error instanceof DiscoveryProblem) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'issuer', message: error.message }],
          internal: error.code,
        });
      }
      throw error;
    }
  }

  /**
   * The role new members get through SSO must be within the chooser's own access (A03), and may
   * not include actions that need two-step verification: nobody arrives through SSO with those.
   */
  private async jitRole(tx: TenantTx, principal: StaffPrincipal, publicId: string) {
    const roleId = parseId('role', publicId);
    const [role] = await tx
      .select()
      .from(schema.roleDefinitions)
      .where(and(eq(schema.roleDefinitions.id, roleId), isNull(schema.roleDefinitions.archivedAt)));
    if (!role) throw new AppError('NOT_FOUND', { detail: 'Role not found.' });
    const patterns = rolePatterns(role);
    const guarded = expandPatterns(patterns).filter((p) => {
      const spec = PERMISSIONS[p];
      return 'mfa' in spec && spec.mfa;
    });
    if (guarded.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [
          {
            path: 'jitRoleId',
            message: `New members can’t get actions that need two-step verification (${guarded.join(', ')}).`,
          },
        ],
      });
    }
    const problems = checkDelegation(
      principal,
      {
        granteeStaffMemberId: 'sso:new-member',
        permissions: patterns,
        scope: { type: 'tenant' },
        expiresAt: null,
      },
      () => ({}),
      this.clock(),
    );
    if (problems.length > 0) throw delegationError(problems);
    return role;
  }

  private assertIssuerProtocol(issuer: string) {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' && !this.outbound.trustedOrigins.includes(url.origin)) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'issuer', message: 'The issuer must use HTTPS.' }],
      });
    }
  }

  async createConnection(
    principal: StaffPrincipal,
    input: z.output<typeof CreateSsoConnectionRequest>,
  ): Promise<SsoConnection> {
    const domainId = parseId('ssoDomain', input.domainId);
    this.assertIssuerProtocol(input.issuer);
    const endpoints = await this.discover(input.issuer);
    try {
      return await this.tx(principal, async (tx) => {
        const [domain] = await tx
          .select()
          .from(schema.ssoDomains)
          .where(eq(schema.ssoDomains.id, domainId));
        if (!domain) throw new AppError('NOT_FOUND', { detail: 'Domain not found.' });
        if (!domain.verifiedAt) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'domainId', message: 'Verify the domain before connecting SSO.' }],
          });
        }
        const id = newId();
        const secretId = await this.broker.storeIn(tx, principal.tenantId, {
          kind: 'sso_client_secret',
          label: `SSO client secret for ${domain.domain}`,
          value: input.clientSecret,
        });
        const [row] = await tx
          .insert(schema.ssoConnections)
          .values({
            id,
            tenantId: principal.tenantId,
            domainId,
            providerId: toPublicId('ssoConnection', id),
            issuer: input.issuer,
            clientId: input.clientId,
            clientSecretId: secretId,
            authorizationEndpoint: endpoints.authorization,
            tokenEndpoint: endpoints.token,
            jwksEndpoint: endpoints.jwks,
            userInfoEndpoint: endpoints.userInfo,
            tokenEndpointAuth: endpoints.tokenEndpointAuth,
            ...(input.scopes?.length ? { scopes: [...new Set(['openid', ...input.scopes])] } : {}),
            createdBy: principal.staffMemberId,
          })
          .returning();
        if (!row) throw new Error('connection not returned');
        await this.audit(tx, principal, {
          action: 'sso.connection_created',
          targetType: 'sso_connection',
          targetId: row.providerId,
          data: { domain: domain.domain, issuer: row.issuer, clientId: row.clientId },
        });
        return this.connectionView(tx, row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'sso_connections_domain_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'domainId', message: 'This domain already has a connection.' }],
        });
      }
      throw error;
    }
  }

  async updateConnection(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateSsoConnectionRequest>,
  ): Promise<SsoConnection> {
    const connectionId = parseId('ssoConnection', publicId);
    if (input.issuer) this.assertIssuerProtocol(input.issuer);
    const endpoints = input.issuer ? await this.discover(input.issuer) : null;
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.ssoConnections)
        .where(eq(schema.ssoConnections.id, connectionId))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      if (row.version !== input.version) throw new AppError('VERSION_CONFLICT');
      const changes: string[] = [];
      const next: Partial<ConnectionRow> = { version: row.version + 1 };
      if (input.issuer && endpoints && input.issuer !== row.issuer) {
        Object.assign(next, {
          issuer: input.issuer,
          authorizationEndpoint: endpoints.authorization,
          tokenEndpoint: endpoints.token,
          jwksEndpoint: endpoints.jwks,
          userInfoEndpoint: endpoints.userInfo,
          tokenEndpointAuth: endpoints.tokenEndpointAuth,
        });
        changes.push('issuer');
      }
      if (input.clientId !== undefined && input.clientId !== row.clientId) {
        next.clientId = input.clientId;
        changes.push('clientId');
      }
      if (input.clientSecret !== undefined) {
        await this.broker.rotateIn(tx, principal.tenantId, row.clientSecretId, input.clientSecret);
        changes.push('clientSecret');
      }
      const status = input.status ?? row.status;
      if (status !== row.status) {
        next.status = status;
        changes.push('status');
      }
      // Requiring SSO only makes sense while SSO works; turning SSO off lifts the requirement.
      const ssoOnly = status === 'active' ? (input.ssoOnly ?? row.ssoOnly) : false;
      if (input.ssoOnly && status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'ssoOnly', message: 'Turn the connection on before requiring SSO.' }],
        });
      }
      if (ssoOnly !== row.ssoOnly) {
        next.ssoOnly = ssoOnly;
        changes.push('ssoOnly');
      }
      let jitRoleKey: string | null | undefined;
      if (input.jitRoleId !== undefined) {
        if (input.jitRoleId === null) {
          if (row.jitRoleId) changes.push('jitRole');
          next.jitRoleId = null;
          next.jitGrantedBy = null;
          jitRoleKey = null;
        } else {
          const role = await this.jitRole(tx, principal, input.jitRoleId);
          if (role.id !== row.jitRoleId) changes.push('jitRole');
          next.jitRoleId = role.id;
          next.jitGrantedBy = principal.staffMemberId;
          jitRoleKey = role.key;
        }
      }
      const [updated] = await tx
        .update(schema.ssoConnections)
        .set(next)
        .where(eq(schema.ssoConnections.id, connectionId))
        .returning();
      if (!updated) throw new Error('connection not returned');
      await this.audit(tx, principal, {
        action: 'sso.connection_updated',
        targetType: 'sso_connection',
        targetId: publicId,
        data: {
          changes,
          status: updated.status,
          ssoOnly: updated.ssoOnly,
          ...(jitRoleKey !== undefined ? { jitRole: jitRoleKey } : {}),
        },
      });
      return this.connectionView(tx, updated);
    });
  }

  async deleteConnection(principal: StaffPrincipal, publicId: string): Promise<void> {
    const connectionId = parseId('ssoConnection', publicId);
    await this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.ssoConnections)
        .where(eq(schema.ssoConnections.id, connectionId))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND');
      await tx.delete(schema.ssoConnections).where(eq(schema.ssoConnections.id, connectionId));
      await this.broker.revokeIn(tx, row.clientSecretId);
      await this.audit(tx, principal, {
        action: 'sso.connection_removed',
        targetType: 'sso_connection',
        targetId: publicId,
        data: { issuer: row.issuer, wasActive: row.status === 'active', ssoOnly: row.ssoOnly },
      });
    });
  }
}
