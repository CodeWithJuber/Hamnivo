import type {
  ApproveSupportRequest,
  SupportGrant,
  SupportScope,
  WorkspaceNotices,
} from '@hamnivo/contracts';
import {
  appendAudit,
  appendPlatformAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { channelKindOf } from '../authority/adopt.js';
import { CHANNEL_ALERT_AFTER_MS } from '../authority/channel-health.js';
import { AppError } from '../common/app-error.js';
import { APP_DB, CLOCK, type Clock, PLATFORM_DB } from '../tokens.js';
import { isSupportActive, supportGrantView } from './views.js';

type Row = typeof schema.supportGrants.$inferSelect;

/**
 * Support access, the tenant's side (A18): owners approve, narrow, decline or revoke what a
 * platform support operator asked for. Access is read-only and ends at the approved time. Every
 * decision is recorded in the tenant's audit log and in the platform's.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(PLATFORM_DB) private readonly platform: Db | null,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private parseId(publicId: string): string {
    try {
      return fromPublicId('supportGrant', publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }

  private async views(tx: TenantTx, tenantId: string, rows: Row[]): Promise<SupportGrant[]> {
    const [tenant] = await tx
      .select({ id: schema.tenants.id, name: schema.tenants.name })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    const people = await tx
      .select({ id: schema.staffMembers.id, displayName: schema.staffMembers.displayName })
      .from(schema.staffMembers);
    const byId = new Map(people.map((p) => [p.id, p]));
    const now = this.clock();
    return rows.map((row) =>
      supportGrantView(
        row,
        tenant ?? { id: tenantId, name: '' },
        byId.get(row.approvedBy ?? row.declinedBy ?? '') ?? null,
        now,
      ),
    );
  }

  async list(principal: StaffPrincipal): Promise<SupportGrant[]> {
    return this.tx(principal, async (tx) =>
      this.views(
        tx,
        principal.tenantId,
        await tx
          .select()
          .from(schema.supportGrants)
          .orderBy(desc(schema.supportGrants.requestedAt))
          .limit(100),
      ),
    );
  }

  /** Records a tenant decision in the platform audit log too (operators see what happened). */
  private async platformRecord(
    action: string,
    tenantId: string,
    row: Row,
    data: Record<string, unknown>,
  ) {
    if (!this.platform) return;
    try {
      await this.platform.transaction((tx) =>
        appendPlatformAudit(tx, {
          operatorId: null,
          action,
          tenantId,
          targetType: 'support_grant',
          targetId: toPublicId('supportGrant', row.id),
          outcome: 'success',
          data,
        }),
      );
    } catch (error) {
      this.logger.warn(`platform audit of ${action} failed: ${String(error)}`);
    }
  }

  private async lockPending(tx: TenantTx, grantId: string): Promise<Row> {
    const [row] = await tx
      .select()
      .from(schema.supportGrants)
      .where(eq(schema.supportGrants.id, grantId))
      .for('update');
    if (!row) throw new AppError('NOT_FOUND');
    if (row.status !== 'pending') {
      throw new AppError('VERSION_CONFLICT', { detail: 'This request was already decided.' });
    }
    return row;
  }

  async approve(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ApproveSupportRequest>,
  ): Promise<SupportGrant> {
    const grantId = this.parseId(publicId);
    const { view, row } = await this.tx(principal, async (tx) => {
      const pending = await this.lockPending(tx, grantId);
      const asked = pending.scopes as SupportScope[];
      const scopes = input.scopes ? [...new Set(input.scopes)] : asked;
      if (scopes.some((scope) => !asked.includes(scope))) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            { path: 'scopes', message: 'You can narrow the access asked for, not widen it.' },
          ],
        });
      }
      const minutes = input.durationMinutes ?? pending.durationMinutes;
      if (minutes > pending.durationMinutes) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            {
              path: 'durationMinutes',
              message: 'You can shorten the time asked for, not extend it.',
            },
          ],
        });
      }
      const now = this.clock();
      const [approved] = await tx
        .update(schema.supportGrants)
        .set({
          status: 'approved',
          approvedBy: principal.staffMemberId,
          decidedAt: now,
          decisionNote: input.note ?? null,
          scopes,
          durationMinutes: minutes,
          startsAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        })
        .where(eq(schema.supportGrants.id, grantId))
        .returning();
      if (!approved) throw new Error('support grant not returned');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'support.approved',
        targetType: 'support_grant',
        targetId: publicId,
        outcome: 'success',
        reason: input.note ?? null,
        data: {
          operator: toPublicId('operator', approved.platformUserId),
          scopes,
          minutes,
          expiresAt: approved.expiresAt.toISOString(),
        },
      });
      const [view] = await this.views(tx, principal.tenantId, [approved]);
      return { view: view as SupportGrant, row: approved };
    });
    await this.platformRecord('support.approved', principal.tenantId, row, {
      scopes: row.scopes,
      minutes: row.durationMinutes,
      by: toPublicId('staff', principal.staffMemberId),
    });
    return view;
  }

  async decline(
    principal: StaffPrincipal,
    publicId: string,
    note: string | undefined,
  ): Promise<SupportGrant> {
    const grantId = this.parseId(publicId);
    const { view, row } = await this.tx(principal, async (tx) => {
      await this.lockPending(tx, grantId);
      const [declined] = await tx
        .update(schema.supportGrants)
        .set({
          status: 'declined',
          declinedBy: principal.staffMemberId,
          decidedAt: this.clock(),
          decisionNote: note ?? null,
        })
        .where(eq(schema.supportGrants.id, grantId))
        .returning();
      if (!declined) throw new Error('support grant not returned');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'support.declined',
        targetType: 'support_grant',
        targetId: publicId,
        outcome: 'success',
        reason: note ?? null,
        data: { operator: toPublicId('operator', declined.platformUserId) },
      });
      const [view] = await this.views(tx, principal.tenantId, [declined]);
      return { view: view as SupportGrant, row: declined };
    });
    await this.platformRecord('support.declined', principal.tenantId, row, {
      by: toPublicId('staff', principal.staffMemberId),
    });
    return view;
  }

  /** Ends approved access at once; the operator's next read is refused. */
  async revoke(
    principal: StaffPrincipal,
    publicId: string,
    reason: string | undefined,
  ): Promise<SupportGrant> {
    const grantId = this.parseId(publicId);
    const { view, row, changed } = await this.tx(principal, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.supportGrants)
        .where(eq(schema.supportGrants.id, grantId))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND');
      if (!isSupportActive(current, this.clock())) {
        const [view] = await this.views(tx, principal.tenantId, [current]);
        return { view: view as SupportGrant, row: current, changed: false };
      }
      const [revoked] = await tx
        .update(schema.supportGrants)
        .set({ revokedAt: this.clock(), revokedBy: principal.staffMemberId })
        .where(eq(schema.supportGrants.id, grantId))
        .returning();
      if (!revoked) throw new Error('support grant not returned');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'support.revoked',
        targetType: 'support_grant',
        targetId: publicId,
        outcome: 'success',
        reason: reason ?? null,
        data: { operator: toPublicId('operator', revoked.platformUserId) },
      });
      const [view] = await this.views(tx, principal.tenantId, [revoked]);
      return { view: view as SupportGrant, row: revoked, changed: true };
    });
    if (changed) {
      await this.platformRecord('support.revoked', principal.tenantId, row, {
        by: toPublicId('staff', principal.staffMemberId),
      });
    }
    return view;
  }

  /** Banners for every member: support access in use now, and platform incidents. */
  async notices(principal: StaffPrincipal): Promise<z.infer<typeof WorkspaceNotices>> {
    const now = this.clock();
    const grants = await this.tx(principal, (tx) =>
      tx
        .select()
        .from(schema.supportGrants)
        .where(
          and(
            eq(schema.supportGrants.status, 'approved'),
            isNull(schema.supportGrants.revokedAt),
            isNull(schema.supportGrants.endedAt),
            gt(schema.supportGrants.expiresAt, now),
          ),
        )
        .orderBy(asc(schema.supportGrants.expiresAt)),
    );
    const pending = await this.tx(principal, (tx) =>
      tx
        .select({ id: schema.supportGrants.id })
        .from(schema.supportGrants)
        .where(eq(schema.supportGrants.status, 'pending')),
    );
    return {
      supportAccess: grants.map((row) => ({
        id: toPublicId('supportGrant', row.id),
        operatorName: row.operatorName,
        scopes: row.scopes as SupportScope[],
        expiresAt: row.expiresAt.toISOString(),
      })),
      pendingSupportRequests: pending.length,
      incidents: await this.incidents(),
      unhealthyChannels: await this.unhealthyChannels(principal, now),
    };
  }

  /**
   * Channels down for more than 15 minutes (A11), for the people who can fix them: those who
   * manage the brand's integrations. A blip shorter than that shows nothing.
   */
  private async unhealthyChannels(
    principal: StaffPrincipal,
    now: Date,
  ): Promise<z.infer<typeof WorkspaceNotices>['unhealthyChannels']> {
    const rows = await this.tx(principal, (tx) =>
      tx
        .select({ inbox: schema.authorityInboxes, brand: schema.brands })
        .from(schema.authorityInboxes)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.authorityInboxes.brandId))
        .where(
          and(
            eq(schema.authorityInboxes.purpose, 'channel'),
            eq(schema.authorityInboxes.status, 'active'),
            isNull(schema.authorityInboxes.pausedAt),
            sql`${schema.authorityInboxes.health}->>'ok' = 'false'`,
          ),
        ),
    );
    return rows
      .filter(({ inbox, brand }) => {
        const since = Date.parse(inbox.health?.checkedAt ?? '');
        return (
          Number.isFinite(since) &&
          now.getTime() - since >= CHANNEL_ALERT_AFTER_MS &&
          authorize(
            principal,
            'integrations.manage',
            { workspaceId: brand.workspaceId, brandId: brand.id },
            { now },
          ).allowed
        );
      })
      .map(({ inbox, brand }) => ({
        id: toPublicId('inbox', inbox.id),
        brandId: toPublicId('brand', brand.id),
        brandName: brand.name,
        kind: channelKindOf(inbox.channelType),
        name: inbox.name ?? inbox.channelType.replace('Channel::', ''),
        address: inbox.displayAddress,
        problem: inbox.health?.message ?? null,
        since: inbox.health?.checkedAt ?? now.toISOString(),
      }));
  }

  private async incidents(): Promise<z.infer<typeof WorkspaceNotices>['incidents']> {
    if (!this.platform) return [];
    try {
      const rows = await this.platform
        .select()
        .from(schema.platformIncidents)
        .where(eq(schema.platformIncidents.status, 'active'))
        .orderBy(desc(schema.platformIncidents.startedAt))
        .limit(5);
      return rows.map((row) => ({
        id: toPublicId('incident', row.id),
        title: row.title,
        message: row.message,
        severity: row.severity,
        startedAt: row.startedAt.toISOString(),
      }));
    } catch (error) {
      this.logger.warn(`incidents could not be read: ${String(error)}`);
      return [];
    }
  }
}
