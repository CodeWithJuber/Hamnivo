import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Commerce wrappers for SECURITY DEFINER functions (see resolvers.ts): which tenant a merchant
 * webhook belongs to, and the worker's cross-tenant leases. Processing happens in withTenant().
 */

export interface MerchantConnectionResolution {
  tenantId: string;
  provider: string;
  status: string;
  tenantStatus: string;
}

export async function resolveMerchantConnection(
  db: Db,
  connectionId: string,
): Promise<MerchantConnectionResolution | null> {
  const { rows } = await db.execute<{
    tenant_id: string;
    provider: string;
    status: string;
    tenant_status: string;
  }>(sql`select * from app.resolve_merchant_connection(${connectionId}::uuid)`);
  const row = rows[0];
  return row
    ? {
        tenantId: row.tenant_id,
        provider: row.provider,
        status: row.status,
        tenantStatus: row.tenant_status,
      }
    : null;
}

export interface ClaimedCommerceEvent {
  tenantId: string;
  id: string;
  merchantConnectionId: string;
  attempts: number;
}

/** Leases verified provider events across tenants for `leaseSeconds`. */
export async function claimCommerceEvents(
  db: Db,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedCommerceEvent[]> {
  const { rows } = await db.execute<{
    tenant_id: string;
    id: string;
    merchant_connection_id: string;
    attempts: number;
  }>(
    sql`select * from app.claim_commerce_events(${options.limit}::int, ${options.leaseSeconds}::int)`,
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    id: row.id,
    merchantConnectionId: row.merchant_connection_id,
    attempts: row.attempts,
  }));
}

export interface ClaimedCommerceWork {
  tenantId: string;
  subject: 'operation' | 'payment' | 'refund';
  id: string;
}

/**
 * Leases operations, payments and refunds that are still owed an outcome by a provider. Each
 * lease moves the next attempt `leaseSeconds` ahead; the worker then sets the real next time.
 */
export async function claimCommerceWork(
  db: Db,
  options: { limit: number; leaseSeconds: number },
): Promise<ClaimedCommerceWork[]> {
  const { rows } = await db.execute<{ tenant_id: string; subject: string; id: string }>(
    sql`select * from app.claim_commerce_work(${options.limit}::int, ${options.leaseSeconds}::int)`,
  );
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    subject: row.subject as ClaimedCommerceWork['subject'],
    id: row.id,
  }));
}
