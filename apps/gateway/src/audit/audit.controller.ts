import { adminRoutes } from '@hamnivo/contracts';
import { type Db, schema, toPublicId, verifyAuditChain, withTenant } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { APP_DB } from '../tokens.js';

@Controller('v1/admin/audit')
export class AuditController {
  constructor(@Inject(APP_DB) private readonly db: Db) {}

  private tx<T>(principal: StaffPrincipal, work: Parameters<typeof withTenant<T>>[2]) {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  @Get()
  @StaffRoute({ tenant: true, permission: 'audit.read', tenantWide: true })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const { before, limit, action } = parseInput(adminRoutes.listAudit.query, query);
    return this.tx(principal, async (tx) => {
      const conditions: SQL[] = [];
      if (before) conditions.push(lt(schema.auditEvents.seq, before));
      if (action) conditions.push(eq(schema.auditEvents.action, action));
      const rows = await tx
        .select()
        .from(schema.auditEvents)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(schema.auditEvents.seq))
        .limit(limit + 1);
      const items = rows.slice(0, limit).map((e) => ({
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
      }));
      return { items, nextBefore: rows.length > limit ? (items.at(-1)?.seq ?? null) : null };
    });
  }

  @Get('verify')
  @StaffRoute({ tenant: true, permission: 'audit.read', tenantWide: true })
  verify(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.tx(principal, (tx) => verifyAuditChain(tx));
  }
}
