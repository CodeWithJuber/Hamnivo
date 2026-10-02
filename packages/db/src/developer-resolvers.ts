import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { asDate } from './resolvers.js';
import type { TenantTx } from './tenant.js';

/**
 * Developer-platform wrappers for SECURITY DEFINER functions (see resolvers.ts): the webhook
 * delivery worker's cross-tenant lease, event retention, and a tenant's own invoices (which live
 * in the global `invoices` table the application role cannot read).
 */

export interface ClaimedWebhookDelivery {
  tenantId: string;
  id: string;
  attempts: number;
}

/**
 * Leases due webhook deliveries across active tenants for `leaseSeconds`. Each is then sent and
 * recorded inside withTenant(); a lease that is not finished simply expires.
 */
export async function claimWebhookDeliveries(
  db: Db,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedWebhookDelivery[]> {
  const { rows } = await db.execute<{ tenant_id: string; id: string; attempts: number }>(
    sql`select * from app.claim_webhook_deliveries(${options.limit}::int, ${options.leaseSeconds}::int)`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, id: row.id, attempts: row.attempts }));
}

/** Clears bodies of expired webhook events and deletes events older than `keepDays`. */
export async function purgeWebhookEvents(
  db: Db,
  options: { batch?: number; keepDays: number },
): Promise<{ cleared: number; deleted: number }> {
  const { rows } = await db.execute<{ cleared: string; deleted: string }>(
    sql`select * from app.purge_webhook_events(${options.batch ?? 5000}::int, ${options.keepDays}::int)`,
  );
  return { cleared: Number(rows[0]?.cleared ?? 0), deleted: Number(rows[0]?.deleted ?? 0) };
}

export interface TenantInvoiceRow {
  id: string;
  number: string;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  planName: string;
  status: 'issued' | 'paid' | 'void';
  currency: string;
  subtotalMinor: bigint;
  totalMinor: bigint;
  lines: Record<string, unknown>[];
  usage: Record<string, number>;
  issuedAt: Date | null;
  dueAt: Date | null;
  paidAt: Date | null;
  voidedAt: Date | null;
  paymentMethod: 'manual' | 'provider';
  paymentState: 'none' | 'pending' | 'failed' | 'paid';
  paymentFailedAt: Date | null;
  nextPaymentRetryAt: Date | null;
}

/**
 * The current tenant's issued, paid and voided invoices, newest period first (inside withTenant;
 * drafts stay with the platform operator until issued).
 */
export async function tenantInvoices(
  tx: TenantTx,
  invoiceId: string | null = null,
): Promise<TenantInvoiceRow[]> {
  const { rows } = await tx.execute<{
    id: string;
    number: string;
    period_key: string;
    period_start: string;
    period_end: string;
    plan_name: string;
    status: TenantInvoiceRow['status'];
    currency: string;
    subtotal_minor: string;
    total_minor: string;
    lines: Record<string, unknown>[];
    usage: Record<string, number>;
    issued_at: string | null;
    due_at: string | null;
    paid_at: string | null;
    voided_at: string | null;
    payment_method: TenantInvoiceRow['paymentMethod'];
    payment_state: TenantInvoiceRow['paymentState'];
    payment_failed_at: string | null;
    next_payment_retry_at: string | null;
  }>(sql`select * from app.tenant_invoices(${invoiceId}::uuid)`);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    periodKey: row.period_key,
    periodStart: new Date(row.period_start),
    periodEnd: new Date(row.period_end),
    planName: row.plan_name,
    status: row.status,
    currency: row.currency,
    subtotalMinor: BigInt(row.subtotal_minor),
    totalMinor: BigInt(row.total_minor),
    lines: row.lines,
    usage: row.usage,
    issuedAt: asDate(row.issued_at),
    dueAt: asDate(row.due_at),
    paidAt: asDate(row.paid_at),
    voidedAt: asDate(row.voided_at),
    paymentMethod: row.payment_method,
    paymentState: row.payment_state,
    paymentFailedAt: asDate(row.payment_failed_at),
    nextPaymentRetryAt: asDate(row.next_payment_retry_at),
  }));
}
