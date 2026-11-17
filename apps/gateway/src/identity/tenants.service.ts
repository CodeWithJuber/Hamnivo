import { createHash, randomBytes } from 'node:crypto';
import type {
  CreateTenantRequest,
  Membership,
  OperatorCreateAccountRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  newId,
  resolveStaffMemberships,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, ROLE_PRESETS, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { z } from 'zod';
import { queueTenantBrandSetup } from '../authority/provisioning.service.js';
import { billingAccount } from '../billing/accounts.js';
import { applyPlan, NO_PLAN, planByKey, trialEnd } from '../billing/plans.js';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { readBrandWebsite } from '../knowledge/web/brand-website.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { type Mailer, sendTemplate } from '../platform/mailer.js';
import { SignupPolicy } from '../platform/signup.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import type { AuthSession } from './auth.factory.js';
import { enforce } from './staff.guard.js';

type MembershipView = z.infer<typeof Membership>;
type OperatorAccountInput = z.output<typeof OperatorCreateAccountRequest>;

/** UUID (version 8, RFC 9562) derived from a name, so a retried creation reuses the same ID. */
export function deterministicUuid(name: string): string {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A workspace handle from a name: lowercase letters, digits and hyphens, 3 to 40 long. */
export function slugFrom(name: string, suffix = ''): string {
  const base =
    name
      .normalize('NFKD')
      // Accents come apart into their own marks; they go, the letters stay.
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, suffix ? 40 - suffix.length - 1 : 40)
      .replace(/-+$/g, '') || 'workspace';
  const padded = base.length < 3 ? `${base}-ws` : base;
  return suffix ? `${padded}-${suffix}` : padded;
}

/** A billing system's reference: `whmcs:42` is billed by WHMCS, anything else by hand. */
export function externalProvider(externalRef: string): 'whmcs' | 'manual' {
  return externalRef.startsWith('whmcs:') ? 'whmcs' : 'manual';
}

const INVITATION_DAYS = 7;
/** The inviter of an owner a billing system asked for; never a person, never a seat. */
const SYSTEM_AUTH_USER = 'system:hamnivo';

interface Seeded {
  ownerRoleId: string;
}

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly signup: SignupPolicy,
  ) {}

  async membership(authUserId: string, tenantId: string): Promise<MembershipView | null> {
    const found = (await resolveStaffMemberships(this.db, authUserId)).find(
      (m) => m.tenantId === tenantId,
    );
    return found
      ? {
          tenant: {
            id: toPublicId('tenant', found.tenantId),
            slug: found.tenantSlug,
            name: found.tenantName,
            status: found.tenantStatus as MembershipView['tenant']['status'],
          },
          staffMemberId: toPublicId('staff', found.staffMemberId),
          status: found.staffStatus as MembershipView['status'],
        }
      : null;
  }

  /** The tenant row, its default workspace and the preset roles. */
  private async seed(
    tx: TenantTx,
    tenantId: string,
    input: { slug: string; name: string; defaultLocale: string },
  ): Promise<Seeded> {
    await tx.insert(schema.tenants).values({
      id: tenantId,
      slug: input.slug,
      name: input.name,
      defaultLocale: input.defaultLocale,
    });
    await tx.insert(schema.workspaces).values({ tenantId, name: 'Main', slug: 'main' });
    let ownerRoleId = '';
    for (const preset of ROLE_PRESETS) {
      const id = newId();
      if (preset.key === 'owner') ownerRoleId = id;
      await tx.insert(schema.roleDefinitions).values({
        id,
        tenantId,
        key: preset.key,
        name: preset.name,
        description: preset.description,
        permissions: [...preset.patterns],
        isPreset: true,
      });
    }
    return { ownerRoleId };
  }

  /**
   * Gives a new workspace its first plan: the one asked for, or HAMNIVO_DEFAULT_PLAN (`free`
   * unless the server says otherwise; `unlimited` gives none). The default plan starts as a
   * trial when it has trial days; an explicit plan only when asked.
   */
  private async startPlan(
    tx: TenantTx,
    tenantId: string,
    request: { planKey?: string; startTrial?: boolean },
    actor: { actorType: 'staff' | 'platform'; actorId: string },
  ): Promise<string | null> {
    const key = request.planKey ?? this.config.HAMNIVO_DEFAULT_PLAN;
    if (key === NO_PLAN) return null;
    const plan = await planByKey(tx, key);
    if (!plan) {
      if (request.planKey) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'planKey', message: `There is no active plan ${request.planKey}.` }],
        });
      }
      throw new Error(
        `The default plan ${key} does not exist; define it with \`billing plan:set\` or set HAMNIVO_DEFAULT_PLAN=unlimited`,
      );
    }
    const now = this.clock();
    const trial = request.planKey ? request.startTrial === true : plan.trialDays > 0;
    await applyPlan(tx, tenantId, plan, {
      ...actor,
      source: request.planKey ? 'operator' : 'default',
      trialEndsAt: trial ? trialEnd(plan, now) : null,
      now,
    });
    return plan.key;
  }

  /**
   * Creates a tenant with a default workspace, the preset roles and the caller as owner (board 01).
   * With an Idempotency-Key the tenant ID is derived from the person and key, so a retry after a
   * lost response returns the tenant created the first time instead of a duplicate. The workspace
   * starts on the default plan; the creator gets a welcome email.
   */
  async create(
    session: AuthSession,
    input: z.output<typeof CreateTenantRequest>,
    idempotencyKey: string | undefined,
  ): Promise<{ membership: MembershipView; replayed: boolean }> {
    return this.createInternal(session, input, idempotencyKey);
  }

  /** An agency administrator may create a separate client tenant while public signup is closed. */
  async createForAgency(
    principal: StaffPrincipal,
    session: AuthSession,
    input: z.output<typeof CreateTenantRequest>,
    idempotencyKey: string | undefined,
  ): Promise<{ membership: MembershipView; replayed: boolean }> {
    enforce(
      authorize(
        principal,
        'agency.manage',
        {},
        {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        },
      ),
    );
    const enabled = await withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: principal.staffMemberId },
      async (tx) => {
        const result = await tx.execute<{ enabled: boolean }>(
          sql`select enabled from agency_configs where tenant_id = ${principal.tenantId}`,
        );
        return result.rows[0]?.enabled === true;
      },
    );
    if (!enabled) throw new AppError('FEATURE_DISABLED', { reason: 'agency_disabled' });
    return this.createInternal(
      session,
      input,
      idempotencyKey ? `agency:${principal.tenantId}:${idempotencyKey}` : undefined,
      principal,
    );
  }

  private async createInternal(
    session: AuthSession,
    input: z.output<typeof CreateTenantRequest>,
    idempotencyKey: string | undefined,
    agency?: StaffPrincipal,
  ): Promise<{ membership: MembershipView; replayed: boolean }> {
    const tenantId = idempotencyKey
      ? deterministicUuid(`tenant:${session.user.id}:${idempotencyKey}`)
      : newId();
    if (idempotencyKey) {
      const existing = await this.membership(session.user.id, tenantId);
      if (existing) return { membership: existing, replayed: true };
    }
    if (!agency) await this.signup.assertMayCreateTenant(session);
    try {
      await withTenant(this.db, { tenantId, actorId: session.user.id }, async (tx) => {
        const { ownerRoleId } = await this.seed(tx, tenantId, input);
        const staffMemberId = newId();
        await tx.insert(schema.staffMembers).values({
          id: staffMemberId,
          tenantId,
          authUserId: session.user.id,
          displayName: session.user.name,
          email: session.user.email,
          status: 'active',
        });
        await tx.insert(schema.grants).values({
          tenantId,
          staffMemberId,
          roleId: ownerRoleId,
          scopeType: 'tenant',
          reason: 'Created the tenant',
        });
        const actor = { actorType: 'staff' as const, actorId: toPublicId('staff', staffMemberId) };
        await appendAudit(tx, {
          ...actor,
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data: { slug: input.slug, name: input.name },
        });
        const plan = await this.startPlan(tx, tenantId, {}, actor);
        await billingAccount(tx, tenantId);
        await enqueueOutbox(tx, tenantId, {
          topic: 'tenant.created',
          aggregateType: 'tenant',
          aggregateId: tenantId,
          payload: { tenantId, slug: input.slug, ownerStaffMemberId: staffMemberId, plan },
        });
        if (agency) {
          // One transaction owns both creation and the directory link. If linking fails (limit,
          // concurrent claim, or disabled mode), the independent tenant creation also rolls back.
          await tx.execute(sql`select set_config('app.tenant_id', ${agency.tenantId}, true)`);
          await tx.insert(schema.agencyClients).values({
            tenantId: agency.tenantId,
            clientTenantId: tenantId,
            createdBy: agency.staffMemberId,
          });
          await tx.execute(sql`select app.fund_agency_client(${tenantId})`);
          await appendAudit(tx, {
            actorType: 'staff',
            actorId: toPublicId('staff', agency.staffMemberId),
            action: 'agency.client_linked',
            targetType: 'tenant',
            targetId: toPublicId('tenant', tenantId),
            outcome: 'success',
            data: { existing: false },
          });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_pkey')) {
        const existing = await this.membership(session.user.id, tenantId);
        if (existing) return { membership: existing, replayed: true };
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
      if (isUniqueViolation(error, 'tenants_slug_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'slug', message: 'This handle is already taken' }],
        });
      }
      throw error;
    }
    const membership = await this.membership(session.user.id, tenantId);
    if (!membership) throw new Error('tenant created without membership');
    await sendTemplate(
      this.mailer,
      { to: session.user.email, template: 'tenants.welcome' },
      {
        kind: 'welcome',
        name: session.user.name,
        workspace: input.name,
        studioUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/overview`,
      },
    ).catch((error: unknown) => this.logger.warn(`welcome email not sent: ${String(error)}`));
    return { membership, replayed: false };
  }

  /** The workspace a billing system created with this reference, if any. */
  async byExternalRef(externalRef: string): Promise<string | null> {
    const { rows } = await this.db.execute<{ tenant_id: string }>(
      sql`select tenant_id from app.billing_account_tenant(${externalProvider(externalRef)}, null, ${externalRef})`,
    );
    return rows[0]?.tenant_id ?? null;
  }

  /**
   * Creates a workspace for a billing system (the operator API, WHMCS CreateAccount): the default
   * workspace and roles, its plan, a first brand when asked (set up in Chatwoot by the worker),
   * and an owner invitation sent by email. The owner signs up (or in) with that address and
   * accepts, which works while public sign-up is closed. Repeating the call with the same
   * external reference returns the same workspace; a retry after a crash finishes the job.
   */
  async createForOperator(
    input: OperatorAccountInput,
    operator: string,
  ): Promise<{ tenantId: string; created: boolean }> {
    const existing = await this.byExternalRef(input.externalRef);
    if (existing) {
      await this.resendOwnerInvitation(existing, input, operator);
      return { tenantId: existing, created: false };
    }
    const tenantId = deterministicUuid(`tenant:external:${input.externalRef}`);
    const provider = externalProvider(input.externalRef);
    const secret = randomBytes(24).toString('base64url');
    const invitationId = newId();
    const actor = { actorType: 'platform' as const, actorId: operator };
    const create = async (slug: string) =>
      withTenant(this.db, { tenantId, actorId: `platform:${operator}` }, async (tx) => {
        const { ownerRoleId } = await this.seed(tx, tenantId, {
          slug,
          name: input.name,
          defaultLocale: input.defaultLocale,
        });
        const plan = await this.startPlan(
          tx,
          tenantId,
          { ...(input.planKey ? { planKey: input.planKey } : {}), startTrial: input.startTrial },
          actor,
        );
        const inviterId = newId();
        await tx.insert(schema.staffMembers).values({
          id: inviterId,
          tenantId,
          authUserId: SYSTEM_AUTH_USER,
          displayName: 'Hamnivo',
          email: 'system@hamnivo.invalid',
          status: 'removed',
        });
        await tx.insert(schema.invitations).values({
          id: invitationId,
          tenantId,
          email: input.owner.email,
          roleId: ownerRoleId,
          scopeType: 'tenant',
          scopeId: null,
          tokenHash: createHash('sha256').update(secret).digest(),
          invitedBy: inviterId,
          expiresAt: new Date(this.clock().getTime() + INVITATION_DAYS * 86_400_000),
        });
        const account = await billingAccount(tx, tenantId, { lock: true, provider });
        await tx
          .update(schema.billingAccounts)
          .set({ provider, subscriptionRef: input.externalRef, planKey: plan })
          .where(sql`${schema.billingAccounts.id} = ${account.id}`);
        let brandId: string | null = null;
        if (input.brand) {
          const [workspace] = await tx.select({ id: schema.workspaces.id }).from(schema.workspaces);
          brandId = newId();
          await tx.insert(schema.brands).values({
            id: brandId,
            tenantId,
            workspaceId: workspace?.id as string,
            name: input.brand.name,
            widgetPublicId: toPublicId('widget', newId()),
            allowedOrigins: input.brand.website ? [new URL(input.brand.website).origin] : [],
          });
          // Its AI learns its website without setup.
          await readBrandWebsite(
            tx,
            {
              id: brandId,
              tenantId,
              workspaceId: workspace?.id as string,
              allowedOrigins: input.brand.website ? [new URL(input.brand.website).origin] : [],
            },
            { staffId: null },
            this.clock(),
          );
          // The tenant.created handler sets up its Chatwoot account; Studio shows it queued.
          if (
            this.config.CHATWOOT_AUTO_PROVISION &&
            this.config.CHATWOOT_URL &&
            this.config.CHATWOOT_PLATFORM_TOKEN
          ) {
            await queueTenantBrandSetup(tx, tenantId, brandId);
          }
        }
        await appendAudit(tx, {
          ...actor,
          action: 'tenant.created',
          targetType: 'tenant',
          targetId: toPublicId('tenant', tenantId),
          outcome: 'success',
          data: {
            slug,
            name: input.name,
            externalRef: input.externalRef,
            owner: input.owner.email,
            plan,
          },
        });
        await enqueueOutbox(tx, tenantId, {
          topic: 'tenant.created',
          aggregateType: 'tenant',
          aggregateId: tenantId,
          payload: { tenantId, slug, plan, externalRef: input.externalRef, brandId },
        });
      });
    const slug = input.slug ?? slugFrom(input.name);
    try {
      try {
        await create(slug);
      } catch (error) {
        // A name someone else's handle already uses gets this workspace's own suffix.
        if (input.slug || !isUniqueViolation(error, 'tenants_slug_key')) throw error;
        await create(slugFrom(input.name, tenantId.slice(0, 6)));
      }
    } catch (error) {
      if (isUniqueViolation(error, 'tenants_pkey')) return { tenantId, created: false };
      if (isUniqueViolation(error, 'tenants_slug_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'slug', message: 'This handle is already taken' }],
        });
      }
      throw error;
    }
    await this.inviteOwner(invitationId, secret, input.name, input.owner.email);
    return { tenantId, created: true };
  }

  private async inviteOwner(invitationId: string, secret: string, workspace: string, to: string) {
    const token = `${toPublicId('invitation', invitationId)}.${secret}`;
    await sendTemplate(
      this.mailer,
      { to, template: 'members.invitation', senderName: workspace },
      {
        kind: 'invitation',
        workspace,
        role: 'Owner',
        acceptUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(token)}`,
        email: to,
        inviter: null,
        days: INVITATION_DAYS,
      },
    ).catch((error: unknown) => this.logger.warn(`owner invitation not sent: ${String(error)}`));
  }

  /**
   * A billing system repeated the creation (its first answer may have been lost): while nobody
   * has accepted the owner invitation yet, it is sent again with a new link and a new week.
   */
  private async resendOwnerInvitation(
    tenantId: string,
    input: OperatorAccountInput,
    operator: string,
  ): Promise<void> {
    const secret = randomBytes(24).toString('base64url');
    const pending = await withTenant(
      this.db,
      { tenantId, actorId: `platform:${operator}` },
      async (tx) => {
        const i = schema.invitations;
        const [invitation] = await tx
          .select({ id: i.id })
          .from(i)
          .innerJoin(
            schema.roleDefinitions,
            sql`${schema.roleDefinitions.tenantId} = ${i.tenantId} and ${schema.roleDefinitions.id} = ${i.roleId}`,
          )
          .where(
            sql`${i.status} = 'pending' and ${i.email} = ${input.owner.email}::citext and ${schema.roleDefinitions.key} = 'owner'`,
          )
          .for('update', { of: i });
        if (!invitation) return null;
        await tx
          .update(i)
          .set({
            tokenHash: createHash('sha256').update(secret).digest(),
            expiresAt: new Date(this.clock().getTime() + INVITATION_DAYS * 86_400_000),
          })
          .where(sql`${i.id} = ${invitation.id}`);
        const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
        return { id: invitation.id, workspace: tenant?.name ?? input.name };
      },
    );
    if (pending) await this.inviteOwner(pending.id, secret, pending.workspace, input.owner.email);
  }
}
