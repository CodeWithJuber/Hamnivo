import { Readable } from 'node:stream';
import { AuditExportQuery, adminRoutes } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  schema,
  toPublicId,
  verifyAuditChain,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { csvHeader, csvRow, ndjsonLine } from './audit-export.js';

type Filters = Omit<z.output<typeof AuditExportQuery>, 'format'>;

const EXPORT_BATCH = 1000;
/** A single export covers at most this many events; narrow by time for more. */
const EXPORT_LIMIT = 200_000;

function conditions(filters: Filters): SQL[] {
  const e = schema.auditEvents;
  const where: SQL[] = [];
  if (filters.action) where.push(eq(e.action, filters.action));
  if (filters.actorType) where.push(eq(e.actorType, filters.actorType));
  if (filters.actorId) where.push(eq(e.actorId, filters.actorId));
  if (filters.targetType) where.push(eq(e.targetType, filters.targetType));
  if (filters.targetId) where.push(eq(e.targetId, filters.targetId));
  if (filters.from) where.push(gte(e.occurredAt, new Date(filters.from)));
  if (filters.to) where.push(lte(e.occurredAt, new Date(filters.to)));
  return where;
}

/**
 * The audit trail (A09): filtered reading, verification of the hash chain, and export. Exporting
 * has its own permission and a fresh sign-in, and is itself recorded in the chain. Audit data
 * holds identifiers and counts, never secrets or remembered customer content.
 */
@Controller('v1/admin/audit')
export class AuditController {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

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
    const { before, limit, ...filters } = parseInput(adminRoutes.listAudit.query, query);
    return this.tx(principal, async (tx) => {
      const where = conditions(filters);
      if (before) where.push(lt(schema.auditEvents.seq, before));
      const rows = await tx
        .select()
        .from(schema.auditEvents)
        .where(where.length > 0 ? and(...where) : undefined)
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

  @Get('export')
  @StaffRoute({ tenant: true, permission: 'audit.export', tenantWide: true })
  async export(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    const { format, ...filters } = parseInput(AuditExportQuery, query);
    // The export is recorded first, so an interrupted download is on the record too. The file
    // holds the events before this one: a consistent snapshot.
    const recorded = await this.tx(principal, async (tx) => {
      const [total] = await tx
        .select({ n: count() })
        .from(schema.auditEvents)
        .where(and(...conditions(filters)));
      return appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'audit.exported',
        targetType: 'audit_log',
        outcome: 'success',
        requestId: String(request.id),
        data: {
          format,
          filters,
          events: Math.min(Number(total?.n ?? 0), EXPORT_LIMIT),
        },
      });
    });
    const where = conditions(filters);
    const tx = this.tx.bind(this);
    async function* lines() {
      if (format === 'csv') yield csvHeader();
      let after = 0;
      let sent = 0;
      while (sent < EXPORT_LIMIT) {
        const rows = await tx(principal, (t) =>
          t
            .select()
            .from(schema.auditEvents)
            .where(
              and(
                ...where,
                gt(schema.auditEvents.seq, after),
                lt(schema.auditEvents.seq, recorded.seq),
              ),
            )
            .orderBy(asc(schema.auditEvents.seq))
            .limit(Math.min(EXPORT_BATCH, EXPORT_LIMIT - sent)),
        );
        for (const row of rows) yield format === 'csv' ? csvRow(row) : ndjsonLine(row);
        sent += rows.length;
        const last = rows.at(-1);
        if (!last || rows.length < EXPORT_BATCH) break;
        after = last.seq;
      }
    }
    const day = this.clock().toISOString().slice(0, 10);
    const tenant = toPublicId('tenant', principal.tenantId);
    return reply
      .header(
        'content-type',
        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      )
      .header(
        'content-disposition',
        `attachment; filename="hamnivo-audit-${tenant}-${day}.${format === 'csv' ? 'csv' : 'ndjson'}"`,
      )
      .header('cache-control', 'no-store')
      .send(Readable.from(lines()));
  }
}
