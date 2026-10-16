import {
  RETENTION_DAYS,
  type RetentionPolicy,
  type RetentionPreview,
  type SetRetentionRequest,
} from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  effectiveRetention,
  planRetention,
  RETENTION_GRACE_DAYS,
  type RetentionState,
  retentionCutoff,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import type { Mailer } from '../platform/mailer.js';
import { senderNameOf } from '../platform/workspace-email.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';

type PolicyRow = typeof schema.retentionPolicies.$inferSelect;

const OFF: RetentionState = { conversationDays: null, pendingDays: null, pendingFrom: null };

const stateOf = (row: PolicyRow | undefined): RetentionState =>
  row
    ? {
        conversationDays: row.conversationDays,
        pendingDays: row.pendingDays,
        pendingFrom: row.pendingFrom,
      }
    : OFF;

/** A period as people say it: 3 months, 1 year, 7 years. */
export function periodName(days: number): string {
  if (days < 365) return `${Math.round(days / 30)} months`;
  const years = Math.round(days / 365);
  return years === 1 ? '1 year' : `${years} years`;
}

const longDate = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' });

/** The active owners' email addresses: they hear when retention changes. */
async function ownerEmails(tx: TenantTx): Promise<string[]> {
  const s = schema.staffMembers;
  const rows = await tx
    .selectDistinct({ email: s.email })
    .from(s)
    .innerJoin(
      schema.grants,
      and(eq(schema.grants.tenantId, s.tenantId), eq(schema.grants.staffMemberId, s.id)),
    )
    .innerJoin(
      schema.roleDefinitions,
      and(
        eq(schema.roleDefinitions.tenantId, schema.grants.tenantId),
        eq(schema.roleDefinitions.id, schema.grants.roleId),
      ),
    )
    .where(
      and(
        eq(s.status, 'active'),
        isNull(schema.grants.revokedAt),
        eq(schema.roleDefinitions.key, 'owner'),
      ),
    );
  return rows.map((row) => row.email);
}

interface Notice {
  to: string[];
  senderName: string;
  workspace: string;
  actor: string;
  next: RetentionState;
}

/**
 * How long the workspace keeps resolved conversations (A10). Deleting sooner waits a grace period,
 * and every owner is emailed when the period changes, so nobody is surprised by what goes.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
  ) {}

  private view(row: PolicyRow | undefined, now: Date): RetentionPolicy {
    const state = effectiveRetention(stateOf(row), now);
    return {
      conversationDays: state.conversationDays,
      pending:
        state.pendingDays !== null && state.pendingFrom
          ? { conversationDays: state.pendingDays, from: state.pendingFrom.toISOString() }
          : null,
      choices: [...RETENTION_DAYS],
      graceDays: RETENTION_GRACE_DAYS,
      sweep: {
        state: row?.sweepState ?? 'idle',
        sweptAt: row?.sweptAt?.toISOString() ?? null,
        conversationsDeleted: row?.conversationsDeleted ?? 0,
        customersDeleted: row?.customersDeleted ?? 0,
      },
      updatedAt: row?.updatedAt.toISOString() ?? null,
      version: row?.version ?? 0,
    };
  }

  get(principal: StaffPrincipal): Promise<RetentionPolicy> {
    return withTenant(this.db, { tenantId: principal.tenantId }, async (tx) => {
      const [row] = await tx.select().from(schema.retentionPolicies).limit(1);
      return this.view(row, this.clock());
    });
  }

  async set(principal: StaffPrincipal, input: SetRetentionRequest): Promise<RetentionPolicy> {
    const now = this.clock();
    const { tenantId } = principal;
    const actorId = toPublicId('staff', principal.staffMemberId);
    const t = schema.retentionPolicies;
    const { view, notice } = await withTenant(this.db, { tenantId, actorId }, async (tx) => {
      const [row] = await tx.select().from(t).limit(1).for('update');
      if ((row?.version ?? 0) !== input.version) throw new AppError('VERSION_CONFLICT');
      const before = effectiveRetention(stateOf(row), now);
      const next = planRetention(before, input.conversationDays, now);
      const values = {
        conversationDays: next.conversationDays,
        pendingDays: next.pendingDays,
        pendingFrom: next.pendingFrom,
        updatedBy: principal.staffMemberId,
        updatedAt: now,
      };
      let saved: PolicyRow | undefined;
      if (row) {
        [saved] = await tx
          .update(t)
          .set({ ...values, version: row.version + 1 })
          .where(eq(t.id, row.id))
          .returning();
      } else {
        // Two first saves at once: one wins, the other read version 0 of a row that now exists.
        [saved] = await tx
          .insert(t)
          .values({ tenantId, ...values })
          .onConflictDoNothing()
          .returning();
        if (!saved) throw new AppError('VERSION_CONFLICT');
      }
      const changed =
        before.conversationDays !== next.conversationDays ||
        before.pendingDays !== next.pendingDays ||
        before.pendingFrom?.getTime() !== next.pendingFrom?.getTime();
      if (!changed) return { view: this.view(saved, now), notice: null };
      await appendAudit(tx, {
        actorType: 'staff',
        actorId,
        action: 'privacy.retention_changed',
        targetType: 'tenant',
        targetId: toPublicId('tenant', tenantId),
        outcome: 'success',
        data: {
          from: before.conversationDays,
          to: next.conversationDays,
          pending: next.pendingDays,
          pendingFrom: next.pendingFrom?.toISOString() ?? null,
        },
        occurredAt: now,
      });
      const [me] = await tx
        .select({ name: schema.staffMembers.displayName, email: schema.staffMembers.email })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, principal.staffMemberId));
      const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
      return {
        view: this.view(saved, now),
        notice: {
          to: await ownerEmails(tx),
          senderName: await senderNameOf(tx),
          workspace: tenant?.name ?? 'your workspace',
          actor: me?.name || me?.email || 'Someone',
          next,
        } satisfies Notice,
      };
    });
    if (notice) await this.notify(notice);
    return view;
  }

  async preview(principal: StaffPrincipal, days: number): Promise<RetentionPreview> {
    const now = this.clock();
    return withTenant(this.db, { tenantId: principal.tenantId }, async (tx) => {
      const [row] = await tx.select().from(schema.retentionPolicies).limit(1);
      const plan = planRetention(effectiveRetention(stateOf(row), now), days, now);
      const c = schema.conversationControls;
      const [found] = await tx
        .select({
          n: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${c.lastActivityAt})`,
        })
        .from(c)
        .where(
          and(eq(c.authorityStatus, 'resolved'), lt(c.lastActivityAt, retentionCutoff(days, now))),
        );
      const oldest = found?.oldest ? new Date(found.oldest) : null;
      return {
        conversationDays: days,
        conversations: found?.n ?? 0,
        oldestActivityAt: oldest?.toISOString() ?? null,
        deletesFrom: (plan.pendingFrom ?? now).toISOString(),
      };
    });
  }

  /** Every owner hears of the change, with the date deleting starts and how to undo it. */
  private async notify(notice: Notice): Promise<void> {
    const { next } = notice;
    const url = `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/settings/privacy`;
    const lines =
      next.pendingDays !== null && next.pendingFrom
        ? [
            `${notice.actor} set ${notice.workspace} to keep resolved conversations for ${periodName(next.pendingDays)}.`,
            '',
            `From ${longDate.format(next.pendingFrom)}, Hamnivo deletes resolved conversations whose last message is older than that, in Chatwoot and in Hamnivo, with their files. Customers left with no conversation are removed too.`,
            '',
            `Until then, an owner can undo this in Studio:\n${url}`,
          ]
        : next.conversationDays === null
          ? [
              `${notice.actor} set ${notice.workspace} to keep conversations until they are deleted by hand. Nothing more is deleted by its age.`,
              '',
              `Retention settings:\n${url}`,
            ]
          : [
              `${notice.actor} set ${notice.workspace} to keep resolved conversations for ${periodName(next.conversationDays)}. Conversations older than that are deleted, in Chatwoot and in Hamnivo.`,
              '',
              `Retention settings:\n${url}`,
            ];
    for (const to of notice.to) {
      await this.mailer
        .send({
          to,
          template: 'privacy.retention_changed',
          subject: `${notice.workspace}: how long conversations are kept has changed`,
          text: lines.join('\n'),
          senderName: notice.senderName,
        })
        .catch((error: unknown) => this.logger.warn(`retention email failed: ${String(error)}`));
    }
  }
}
