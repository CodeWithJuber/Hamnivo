import type {
  RequestSupportAccessRequest,
  SupportAudit,
  SupportConfiguration,
  SupportConversations,
  SupportGrant,
  SupportScope,
} from '@hamnivo/contracts';
import {
  appendAudit,
  appendPlatformAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, rolePatterns } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { scopeFromRow } from '../identity/principal.service.js';
import type { OperatorContext } from '../identity/request-auth.js';
import type { Mailer } from '../platform/mailer.js';
import { supportGrantView, supportState } from '../support/views.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER, PLATFORM_DB } from '../tokens.js';

type Row = typeof schema.supportGrants.$inferSelect;
type Area = SupportScope;

/**
 * Support access, the platform's side (A18): an operator asks a tenant for temporary, read-only
 * access, and reads only what the tenant approved, while it lasts. Each request, read and end is
 * recorded twice: in the platform audit log and in the tenant's own audit log.
 */
@Injectable()
export class SupportSessionsService {
  private readonly logger = new Logger(SupportSessionsService.name);

  constructor(
    @Inject(PLATFORM_DB) private readonly platformDb: Db | null,
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  private get platform(): Db {
    if (!this.platformDb) throw new AppError('NOT_FOUND');
    return this.platformDb;
  }

  private parseId(kind: 'supportGrant' | 'tenant', publicId: string): string {
    try {
      return fromPublicId(kind, publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  private operatorRef(operator: OperatorContext) {
    return toPublicId('operator', operator.principal.operatorId);
  }

  /** The same event in the tenant's audit log, with the operator as the actor. */
  private tenantRecord(
    operator: OperatorContext,
    tenantId: string,
    entry: {
      action: string;
      targetId: string;
      reason?: string | null;
      data?: Record<string, unknown>;
    },
    work?: (tx: TenantTx) => Promise<void>,
  ) {
    return withTenant(this.db, { tenantId, actorId: this.operatorRef(operator) }, async (tx) => {
      await appendAudit(tx, {
        actorType: 'platform',
        actorId: this.operatorRef(operator),
        action: entry.action,
        targetType: 'support_grant',
        targetId: entry.targetId,
        outcome: 'success',
        reason: entry.reason ?? null,
        data: { operatorName: operator.name, ...(entry.data ?? {}) },
      });
      await work?.(tx);
    });
  }

  private async tenantNames(tenantIds: string[]): Promise<Map<string, string>> {
    if (tenantIds.length === 0) return new Map();
    const rows = await this.platform
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(inArray(schema.tenants.id, tenantIds));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async views(rows: Row[]): Promise<SupportGrant[]> {
    const names = await this.tenantNames([...new Set(rows.map((r) => r.tenantId))]);
    const now = this.clock();
    return rows.map((row) =>
      supportGrantView(row, { id: row.tenantId, name: names.get(row.tenantId) ?? '' }, null, now),
    );
  }

  async list(operator: OperatorContext): Promise<SupportGrant[]> {
    const rows = await this.platform
      .select()
      .from(schema.supportGrants)
      .where(eq(schema.supportGrants.platformUserId, operator.principal.operatorId))
      .orderBy(desc(schema.supportGrants.requestedAt))
      .limit(100);
    return this.views(rows);
  }

  /** People who can decide (support.grant across the tenant), for the request email. */
  private async deciders(tx: TenantTx): Promise<string[]> {
    const rows = await tx
      .select({ member: schema.staffMembers, grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.grants.staffMemberId))
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(
        and(
          isNull(schema.grants.revokedAt),
          eq(schema.grants.scopeType, 'tenant'),
          eq(schema.staffMembers.status, 'active'),
        ),
      );
    const now = this.clock();
    const emails = new Set<string>();
    for (const { member, grant, role } of rows) {
      const decision = authorize(
        {
          kind: 'staff',
          tenantId: member.tenantId,
          staffMemberId: member.id,
          status: 'active',
          mfa: true,
          authenticatedAt: now,
          grants: [
            {
              id: grant.id,
              permissions: rolePatterns(role),
              scope: scopeFromRow(grant.scopeType, grant.scopeId),
              expiresAt: grant.expiresAt,
              revokedAt: null,
            },
          ],
        },
        'support.grant',
        {},
        { now },
      );
      if (decision.allowed) emails.add(member.email);
    }
    return [...emails];
  }

  async request(
    operator: OperatorContext,
    input: z.output<typeof RequestSupportAccessRequest>,
  ): Promise<SupportGrant> {
    const tenantId = this.parseId('tenant', input.tenantId);
    const [tenant] = await this.platform
      .select({ id: schema.tenants.id, name: schema.tenants.name, status: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!tenant) throw new AppError('NOT_FOUND');
    if (tenant.status !== 'active') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This workspace is not active; support access cannot be asked for.',
      });
    }
    const id = newId();
    const now = this.clock();
    const scopes = [...new Set(input.scopes)];
    const row = await this.platform.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.supportGrants)
        .values({
          id,
          tenantId,
          platformUserId: operator.principal.operatorId,
          operatorName: operator.name,
          status: 'pending',
          scopes,
          reason: input.reason,
          durationMinutes: input.durationMinutes,
          requestedAt: now,
          startsAt: now,
          // Until a decision: the window the operator asked for (access starts at approval).
          expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000),
        })
        .returning();
      if (!inserted) throw new Error('support request not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'support.requested',
        tenantId,
        targetType: 'support_grant',
        targetId: toPublicId('supportGrant', id),
        outcome: 'success',
        reason: input.reason,
        data: { scopes, minutes: input.durationMinutes },
      });
      return inserted;
    });
    let deciders: string[] = [];
    await this.tenantRecord(
      operator,
      tenantId,
      {
        action: 'support.requested',
        targetId: toPublicId('supportGrant', id),
        reason: input.reason,
        data: { scopes, minutes: input.durationMinutes },
      },
      async (tx) => {
        deciders = await this.deciders(tx);
      },
    );
    const link = `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/security`;
    for (const to of deciders) {
      await this.mailer
        .send({
          to,
          template: 'support.requested',
          subject: 'Hamnivo support asks for temporary access',
          text: `${operator.name} from Hamnivo support asks to read part of ${tenant.name} for ${input.durationMinutes} minutes (${scopes.join(', ')}).\n\nReason: ${input.reason}\n\nNothing is shared until an owner approves. Review the request:\n${link}`,
        })
        .catch((error) => this.logger.warn(`support request email failed: ${String(error)}`));
    }
    const [view] = await this.views([row]);
    return view as SupportGrant;
  }

  private async ownGrant(operator: OperatorContext, publicId: string): Promise<Row> {
    const grantId = this.parseId('supportGrant', publicId);
    const [row] = await this.platform
      .select()
      .from(schema.supportGrants)
      .where(
        and(
          eq(schema.supportGrants.id, grantId),
          eq(schema.supportGrants.platformUserId, operator.principal.operatorId),
        ),
      );
    // Another operator's grant is not theirs to use or see.
    if (!row) throw new AppError('NOT_FOUND');
    return row;
  }

  async end(operator: OperatorContext, publicId: string): Promise<SupportGrant> {
    const row = await this.ownGrant(operator, publicId);
    if (supportState(row, this.clock()) !== 'active') {
      const [view] = await this.views([row]);
      return view as SupportGrant;
    }
    const ended = await this.platform.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.supportGrants)
        .set({ endedAt: this.clock() })
        .where(eq(schema.supportGrants.id, row.id))
        .returning();
      if (!updated) throw new Error('support grant not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'support.ended',
        tenantId: row.tenantId,
        targetType: 'support_grant',
        targetId: publicId,
        outcome: 'success',
      });
      return updated;
    });
    await this.tenantRecord(operator, row.tenantId, {
      action: 'support.ended',
      targetId: publicId,
    });
    const [view] = await this.views([ended]);
    return view as SupportGrant;
  }

  /**
   * Opens an approved grant for one area: it must be the operator's own, active now, and cover
   * the area. The access is recorded on both sides before anything is read.
   */
  private async open(operator: OperatorContext, publicId: string, area: Area): Promise<Row> {
    const row = await this.ownGrant(operator, publicId);
    const state = supportState(row, this.clock());
    if (state !== 'active') {
      throw new AppError('SCOPE_DENIED', {
        detail:
          state === 'pending'
            ? 'The workspace has not approved this request yet.'
            : 'This support access has ended. Ask the workspace again if you still need it.',
      });
    }
    if (!(row.scopes as Area[]).includes(area)) {
      throw new AppError('SCOPE_DENIED', {
        detail: 'The workspace did not approve access to this area.',
      });
    }
    await this.platform.transaction((tx) =>
      appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'support.accessed',
        tenantId: row.tenantId,
        targetType: 'support_grant',
        targetId: publicId,
        outcome: 'success',
        data: { area },
      }),
    );
    await this.tenantRecord(operator, row.tenantId, {
      action: 'support.accessed',
      targetId: publicId,
      data: { area },
    });
    return row;
  }

  private read<T>(operator: OperatorContext, row: Row, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(
      this.db,
      { tenantId: row.tenantId, actorId: this.operatorRef(operator) },
      work,
    );
  }

  async configuration(
    operator: OperatorContext,
    publicId: string,
  ): Promise<z.infer<typeof SupportConfiguration>> {
    const row = await this.open(operator, publicId, 'configuration');
    return this.read(operator, row, async (tx) => {
      const members = await tx
        .select()
        .from(schema.staffMembers)
        .where(ne(schema.staffMembers.status, 'removed'))
        .orderBy(asc(schema.staffMembers.displayName));
      const grants = await tx
        .select({ staffMemberId: schema.grants.staffMemberId, role: schema.roleDefinitions.name })
        .from(schema.grants)
        .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
        .where(isNull(schema.grants.revokedAt));
      const roles = await tx
        .select()
        .from(schema.roleDefinitions)
        .where(isNull(schema.roleDefinitions.archivedAt))
        .orderBy(asc(schema.roleDefinitions.name));
      const brands = await tx.select().from(schema.brands).orderBy(asc(schema.brands.name));
      const agents = await tx
        .select()
        .from(schema.agentProfiles)
        .orderBy(asc(schema.agentProfiles.name));
      return {
        members: members.map((m) => ({
          displayName: m.displayName,
          email: m.email,
          status: m.status,
          roles: grants.filter((g) => g.staffMemberId === m.id).map((g) => g.role),
        })),
        roles: roles.map((r) => ({
          name: r.name,
          isPreset: r.isPreset,
          permissions: rolePatterns(r),
        })),
        brands: brands.map((b) => ({
          name: b.name,
          status: b.status,
          allowedOrigins: b.allowedOrigins,
        })),
        agents: agents.map((a) => ({
          name: a.name,
          status: a.status,
          live: a.publishedVersionId !== null,
        })),
      };
    });
  }

  /** Recent conversations, state only: support access never includes what customers wrote. */
  async conversations(
    operator: OperatorContext,
    publicId: string,
  ): Promise<z.infer<typeof SupportConversations>> {
    const row = await this.open(operator, publicId, 'conversations');
    return this.read(operator, row, async (tx) => {
      const rows = await tx
        .select({
          id: schema.conversationControls.id,
          status: schema.conversationControls.authorityStatus,
          ownerMode: schema.conversationControls.ownerMode,
          lastActivityAt: schema.conversationControls.lastActivityAt,
        })
        .from(schema.conversationControls)
        .orderBy(desc(schema.conversationControls.lastActivityAt))
        .limit(50);
      return {
        items: rows.map((r) => ({
          id: toPublicId('conversation', r.id),
          status: r.status,
          ownerMode: r.ownerMode,
          lastActivityAt: r.lastActivityAt.toISOString(),
        })),
      };
    });
  }

  async audit(operator: OperatorContext, publicId: string): Promise<z.infer<typeof SupportAudit>> {
    const row = await this.open(operator, publicId, 'audit');
    return this.read(operator, row, async (tx) => {
      const events = await tx
        .select()
        .from(schema.auditEvents)
        .orderBy(desc(schema.auditEvents.seq))
        .limit(100);
      return {
        items: events.map((e) => ({
          seq: e.seq,
          id: e.id,
          occurredAt: e.occurredAt.toISOString(),
          actor: { type: e.actorType, id: e.actorId },
          action: e.action,
          target: e.targetType ? { type: e.targetType, id: e.targetId } : null,
          outcome: e.outcome,
          reason: e.reason,
          requestId: e.requestId,
          data: e.data,
        })),
      };
    });
  }
}
