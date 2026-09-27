import type { FinanceExceptionView, ResolveExceptionRequest } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { type BrandScope, brandScope, decide, requireBrand } from './access.js';
import { CheckoutService } from './checkout.service.js';
import { RefundsService } from './refunds.service.js';
import { type ExceptionRow, exceptionView } from './views.js';

/**
 * The finance exception list (C19): money situations a person must look at, each with its
 * evidence and the next safe action. "Check" asks the provider again; "resolve" records a
 * person's decision (audited) and never moves money.
 */
@Injectable()
export class FinanceExceptionsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly checkout: CheckoutService,
    private readonly refunds: RefundsService,
  ) {}

  private options() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  private staffTx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  /** The brand an exception belongs to: its order's, or its operation's conversation's. */
  private async scopeOf(tx: TenantTx, row: ExceptionRow): Promise<BrandScope | null> {
    if (row.orderId) {
      const [order] = await tx
        .select({ brandId: schema.orders.brandId })
        .from(schema.orders)
        .where(eq(schema.orders.id, row.orderId));
      if (order) return brandScope(tx, order.brandId);
    }
    if (row.operationId) {
      const [op] = await tx
        .select({ brandId: schema.conversationControls.brandId })
        .from(schema.operations)
        .innerJoin(
          schema.conversationControls,
          eq(schema.conversationControls.id, schema.operations.conversationId),
        )
        .where(eq(schema.operations.id, row.operationId));
      if (op?.brandId) return brandScope(tx, op.brandId);
    }
    return null;
  }

  private async orders(tx: TenantTx, rows: ExceptionRow[]) {
    const ids = [...new Set(rows.map((r) => r.orderId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map<string, { id: string; reference: string }>();
    const found = await tx
      .select({ id: schema.orders.id, reference: schema.orders.reference })
      .from(schema.orders)
      .where(inArray(schema.orders.id, ids));
    return new Map(found.map((o) => [o.id, o]));
  }

  async list(
    principal: StaffPrincipal,
    state: 'open' | 'resolved',
  ): Promise<FinanceExceptionView[]> {
    return this.staffTx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.financeExceptions)
        .where(eq(schema.financeExceptions.state, state))
        .orderBy(desc(schema.financeExceptions.openedAt))
        .limit(200);
      const orders = await this.orders(tx, rows);
      const now = this.clock();
      const visible: FinanceExceptionView[] = [];
      for (const row of rows) {
        const scope = await this.scopeOf(tx, row);
        // Exceptions not tied to a brand need tenant-wide access.
        const allowed = scope
          ? decide(principal, 'commerce.read', scope, this.options()).allowed
          : authorize(principal, 'commerce.read', {}, this.options()).allowed;
        if (allowed) {
          visible.push(
            exceptionView(row, row.orderId ? (orders.get(row.orderId) ?? null) : null, now),
          );
        }
      }
      return visible;
    });
  }

  private async load(tx: TenantTx, principal: StaffPrincipal, publicId: string, lock = false) {
    const query = tx
      .select()
      .from(schema.financeExceptions)
      .where(eq(schema.financeExceptions.id, fromPublicId('financeException', publicId)));
    const [row] = lock ? await query.for('update') : await query;
    const scope = row ? await this.scopeOf(tx, row) : null;
    requireBrand(principal, 'commerce.read', scope, this.options(), 'Exception not found.');
    if (!row || !scope) throw new AppError('NOT_FOUND', { detail: 'Exception not found.' });
    return { row, scope };
  }

  private async view(tx: TenantTx, id: string): Promise<FinanceExceptionView> {
    const [row] = await tx
      .select()
      .from(schema.financeExceptions)
      .where(eq(schema.financeExceptions.id, id));
    if (!row) throw new AppError('NOT_FOUND');
    const orders = await this.orders(tx, [row]);
    return exceptionView(row, row.orderId ? (orders.get(row.orderId) ?? null) : null, this.clock());
  }

  /** Asks the provider again now; the exception closes itself when the provider answers. */
  async check(principal: StaffPrincipal, publicId: string): Promise<FinanceExceptionView> {
    const { row } = await this.staffTx(principal, (tx) => this.load(tx, principal, publicId));
    const tenantId = principal.tenantId;
    if (row.subjectType === 'operation' && row.operationId) {
      const [op] = await this.staffTx(principal, (tx) =>
        tx
          .select()
          .from(schema.operations)
          .where(eq(schema.operations.id, row.operationId as string)),
      );
      if (op?.kind === 'commerce.checkout.create') {
        await this.checkout.reconcileOperation(tenantId, op.id, 'staff');
      } else if (op?.kind === 'commerce.refund.create') {
        await this.refunds.reconcileOperation(tenantId, op.id, 'staff');
      }
    } else if (row.subjectType === 'payment') {
      await this.checkout.syncPayment(tenantId, row.subjectId, 'staff');
    } else if (row.subjectType === 'refund') {
      const [refund] = await this.staffTx(principal, (tx) =>
        tx.select().from(schema.refunds).where(eq(schema.refunds.id, row.subjectId)),
      );
      const [op] = refund?.operationId
        ? await this.staffTx(principal, (tx) =>
            tx
              .select()
              .from(schema.operations)
              .where(
                and(
                  eq(schema.operations.id, refund.operationId as string),
                  inArray(schema.operations.state, ['dispatched', 'unknown']),
                ),
              ),
          )
        : [];
      if (op) await this.refunds.reconcileOperation(tenantId, op.id, 'staff');
      else if (refund) await this.refunds.syncRefund(tenantId, refund.id, 'staff');
    }
    return this.staffTx(principal, (tx) => this.view(tx, row.id));
  }

  async resolve(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ResolveExceptionRequest>,
  ): Promise<FinanceExceptionView> {
    return this.staffTx(principal, async (tx) => {
      const { row, scope } = await this.load(tx, principal, publicId, true);
      enforce(decide(principal, 'commerce.exceptions.resolve', scope, this.options()));
      if (row.state !== 'open') {
        throw new AppError('VERSION_CONFLICT', { detail: 'This exception is already resolved.' });
      }
      const now = this.clock();
      await tx
        .update(schema.financeExceptions)
        .set({
          state: 'resolved',
          resolvedAt: now,
          resolvedBy: principal.staffMemberId,
          resolution: input.resolution,
          resolutionNote: input.note,
          updatedAt: now,
        })
        .where(eq(schema.financeExceptions.id, row.id));
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.exception.resolved',
        targetType: 'finance_exception',
        targetId: publicId,
        outcome: 'success',
        occurredAt: now,
        data: { kind: row.kind, resolution: input.resolution },
      });
      return this.view(tx, row.id);
    });
  }
}
