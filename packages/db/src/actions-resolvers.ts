import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * AI actions: the worker's cross-tenant view of approvals nobody decided in time (a SECURITY
 * DEFINER function that returns only ids), as of the worker's clock. Expiring each one happens in
 * withTenant().
 */
export async function expiredActions(
  db: Db,
  limit: number,
  now: Date = new Date(),
): Promise<{ tenantId: string; id: string }[]> {
  const { rows } = await db.execute<{ tenant_id: string; id: string }>(
    sql`select * from app.expired_actions(${limit}::int, ${now.toISOString()}::timestamptz)`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, id: row.id }));
}
