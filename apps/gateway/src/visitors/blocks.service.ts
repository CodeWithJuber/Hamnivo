import type { BlockDuration, VisitorBlock, VisitorBlockList } from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { aliasedTable, and, desc, eq, gte, isNull, or } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { StatusService } from '../inbox/status.service.js';
import { CLOCK, type Clock } from '../tokens.js';

type BlockRow = typeof schema.visitorBlocks.$inferSelect;

const DAY_MS = 86_400_000;
const DURATION_MS: Record<BlockDuration, number | null> = {
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  always: null,
};
/** Lifted and expired blocks stay listed this long (then maintenance removes them). */
const HISTORY_MS = 90 * DAY_MS;

/** "Visitor 7F3A": a short, stable code for an anonymous visitor, from their id. */
const visitorLabel = (id: string) => `Visitor ${id.replaceAll('-', '').slice(-4).toUpperCase()}`;

/**
 * Blocking visitors (H20) for Studio and the API, under `visitors.block`. A block is on the
 * customer, the browsers linked to them and their signed-in account; never an IP address. Blocks
 * are lifted rather than deleted, and both are audited.
 */
@Injectable()
export class VisitorBlocksService {
  constructor(
    private readonly access: InboxAccess,
    private readonly status: StatusService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private expiry(duration: BlockDuration, now: Date): Date | null {
    const ms = DURATION_MS[duration];
    return ms === null ? null : new Date(now.getTime() + ms);
  }

  private async audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    block: BlockRow,
    data: Record<string, unknown> = {},
  ) {
    await appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'visitor_block',
      targetId: toPublicId('visitorBlock', block.id),
      outcome: 'success',
      data: {
        brand: toPublicId('brand', block.brandId),
        ...(block.conversationId
          ? { conversation: toPublicId('conversation', block.conversationId) }
          : {}),
        expiresAt: block.expiresAt?.toISOString() ?? null,
        ...data,
      },
    });
  }

  /** The customer of a chat, the browsers linked to them and their signed-in account. */
  async blockConversation(
    principal: StaffPrincipal,
    publicId: string,
    input: { reason: string; duration: BlockDuration; closeChat: boolean },
  ): Promise<VisitorBlock> {
    const now = this.clock();
    const block = await this.access.tx(principal, async (tx) => {
      const found = await this.access.authorized(tx, principal, publicId, 'visitors.block');
      const control = found.control;
      if (!control.brandId || !control.principalId) {
        throw new AppError('VALIDATION_FAILED', {
          detail:
            'This conversation did not come from the chat on a website, so there is no visitor to block.',
        });
      }
      const [customer] = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, control.principalId));
      const [browser] = await tx
        .select({ id: schema.visitors.id })
        .from(schema.visitors)
        .where(eq(schema.visitors.principalId, control.principalId))
        .orderBy(desc(schema.visitors.lastSeenAt))
        .limit(1);
      const [row] = await tx
        .insert(schema.visitorBlocks)
        .values({
          tenantId: principal.tenantId,
          brandId: control.brandId,
          principalId: control.principalId,
          visitorId: browser?.id ?? null,
          externalSubject: customer?.kind === 'verified' ? customer.externalSubject : null,
          label: customer?.displayName ?? visitorLabel(control.principalId),
          conversationId: control.id,
          reason: input.reason,
          createdBy: principal.staffMemberId,
          createdAt: now,
          expiresAt: this.expiry(input.duration, now),
        })
        .returning();
      const created = row as BlockRow;
      await this.audit(tx, principal, 'visitor.blocked', created, {
        duration: input.duration,
        signedIn: customer?.kind === 'verified',
      });
      return created;
    });
    if (input.closeChat) {
      await this.status.set(principal, publicId, { status: 'resolved' });
    }
    return this.view(principal, block.id);
  }

  /** A browser on the website, and the customer it chats as when it is linked to one. */
  async blockVisitor(
    principal: StaffPrincipal,
    visitorPublicId: string,
    input: { reason: string; duration: BlockDuration },
  ): Promise<VisitorBlock> {
    let visitorId: string;
    try {
      visitorId = fromPublicId('visitor', visitorPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Visitor not found.' });
    }
    const now = this.clock();
    const block = await this.access.tx(principal, async (tx) => {
      const [visitor] = await tx
        .select({
          id: schema.visitors.id,
          brandId: schema.visitors.brandId,
          principalId: schema.visitors.principalId,
          workspaceId: schema.brands.workspaceId,
        })
        .from(schema.visitors)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.visitors.brandId))
        .where(eq(schema.visitors.id, visitorId));
      if (!visitor) throw new AppError('NOT_FOUND', { detail: 'Visitor not found.' });
      enforce(
        this.access.decide(principal, 'visitors.block', {
          workspaceId: visitor.workspaceId,
          brandId: visitor.brandId,
        }),
      );
      const [customer] = visitor.principalId
        ? await tx
            .select()
            .from(schema.customerPrincipals)
            .where(eq(schema.customerPrincipals.id, visitor.principalId))
        : [];
      const [row] = await tx
        .insert(schema.visitorBlocks)
        .values({
          tenantId: principal.tenantId,
          brandId: visitor.brandId,
          principalId: visitor.principalId,
          visitorId: visitor.id,
          externalSubject: customer?.kind === 'verified' ? customer.externalSubject : null,
          label: customer?.displayName ?? visitorLabel(visitor.id),
          reason: input.reason,
          createdBy: principal.staffMemberId,
          createdAt: now,
          expiresAt: this.expiry(input.duration, now),
        })
        .returning();
      const created = row as BlockRow;
      await this.audit(tx, principal, 'visitor.blocked', created, { duration: input.duration });
      return created;
    });
    return this.view(principal, block.id);
  }

  /** Blocks the caller may see (their `visitors.block` grants' brands), newest first. */
  async list(
    principal: StaffPrincipal,
    query: { brandId?: string | undefined; status: 'active' | 'all' },
  ): Promise<VisitorBlockList> {
    const scope = this.access.scope(principal, 'visitors.block');
    if (!scope) return { items: [] };
    const now = this.clock();
    let brandId: string | null = null;
    if (query.brandId) {
      try {
        brandId = fromPublicId('brand', query.brandId);
      } catch {
        return { items: [] };
      }
    }
    const rows = await this.access.tx(principal, (tx) =>
      this.rows(tx, {
        brandId,
        active: query.status === 'active',
        since: new Date(now.getTime() - HISTORY_MS),
        now,
      }),
    );
    const visible = rows.filter(
      (r) =>
        scope.all ||
        scope.brandIds.includes(r.block.brandId) ||
        scope.workspaceIds.includes(r.workspaceId),
    );
    return { items: visible.map((r) => this.toView(r, now)) };
  }

  /** Unblocks at once; the record stays, marked lifted. */
  async lift(principal: StaffPrincipal, blockPublicId: string): Promise<VisitorBlock> {
    let id: string;
    try {
      id = fromPublicId('visitorBlock', blockPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Block not found.' });
    }
    const now = this.clock();
    await this.access.tx(principal, async (tx) => {
      const [found] = await tx
        .select({ block: schema.visitorBlocks, workspaceId: schema.brands.workspaceId })
        .from(schema.visitorBlocks)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.visitorBlocks.brandId))
        .where(eq(schema.visitorBlocks.id, id))
        .for('update', { of: schema.visitorBlocks });
      if (!found) throw new AppError('NOT_FOUND', { detail: 'Block not found.' });
      enforce(
        this.access.decide(principal, 'visitors.block', {
          workspaceId: found.workspaceId,
          brandId: found.block.brandId,
        }),
      );
      if (found.block.liftedAt) return;
      const [lifted] = await tx
        .update(schema.visitorBlocks)
        .set({ liftedAt: now, liftedBy: principal.staffMemberId })
        .where(and(eq(schema.visitorBlocks.id, id), isNull(schema.visitorBlocks.liftedAt)))
        .returning();
      if (lifted) await this.audit(tx, principal, 'visitor.unblocked', lifted);
    });
    return this.view(principal, id);
  }

  private async view(principal: StaffPrincipal, id: string): Promise<VisitorBlock> {
    const now = this.clock();
    const [row] = await this.access.tx(principal, (tx) => this.rows(tx, { id, now }));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Block not found.' });
    return this.toView(row, now);
  }

  private rows(
    tx: TenantTx,
    filter: { id?: string; brandId?: string | null; active?: boolean; since?: Date; now: Date },
  ) {
    const b = schema.visitorBlocks;
    const creator = aliasedTable(schema.staffMembers, 'creator');
    const lifter = aliasedTable(schema.staffMembers, 'lifter');
    const conditions = [
      filter.id ? eq(b.id, filter.id) : undefined,
      filter.brandId ? eq(b.brandId, filter.brandId) : undefined,
      filter.active
        ? and(isNull(b.liftedAt), or(isNull(b.expiresAt), gte(b.expiresAt, filter.now)))
        : undefined,
      filter.since && !filter.active ? gte(b.createdAt, filter.since) : undefined,
    ].filter((c) => c !== undefined);
    return tx
      .select({
        block: b,
        workspaceId: schema.brands.workspaceId,
        creatorName: creator.displayName,
        lifterName: lifter.displayName,
        signedIn: schema.customerPrincipals.kind,
        conversationExists: schema.conversationControls.id,
      })
      .from(b)
      .innerJoin(schema.brands, eq(schema.brands.id, b.brandId))
      .leftJoin(creator, eq(creator.id, b.createdBy))
      .leftJoin(lifter, eq(lifter.id, b.liftedBy))
      .leftJoin(schema.customerPrincipals, eq(schema.customerPrincipals.id, b.principalId))
      .leftJoin(schema.conversationControls, eq(schema.conversationControls.id, b.conversationId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(b.createdAt), desc(b.id))
      .limit(500);
  }

  private toView(
    row: Awaited<ReturnType<VisitorBlocksService['rows']>>[number],
    now: Date,
  ): VisitorBlock {
    const { block } = row;
    const active = block.liftedAt === null && (block.expiresAt === null || block.expiresAt > now);
    return {
      id: toPublicId('visitorBlock', block.id),
      brandId: toPublicId('brand', block.brandId),
      who: block.label,
      signedIn: block.externalSubject !== null || row.signedIn === 'verified',
      customerId: block.principalId ? toPublicId('customer', block.principalId) : null,
      visitorId: block.visitorId ? toPublicId('visitor', block.visitorId) : null,
      conversationId:
        block.conversationId && row.conversationExists
          ? toPublicId('conversation', block.conversationId)
          : null,
      reason: block.reason,
      createdBy: row.creatorName
        ? { id: toPublicId('staff', block.createdBy), name: row.creatorName }
        : null,
      createdAt: block.createdAt.toISOString(),
      expiresAt: block.expiresAt?.toISOString() ?? null,
      liftedAt: block.liftedAt?.toISOString() ?? null,
      liftedBy:
        block.liftedBy && row.lifterName
          ? { id: toPublicId('staff', block.liftedBy), name: row.lifterName }
          : null,
      active,
    };
  }
}
