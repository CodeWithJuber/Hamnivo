import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * AI actions: the worker's cross-tenant view of approvals nobody decided in time (a SECURITY
 * DEFINER function that returns only ids). Expiring each one happens in withTenant().
 */
export async function expiredActions(
  db: Db,
  limit: number,
): Promise<{ tenantId: string; id: string }[]> {
  const { rows } = await db.execute<{ tenant_id: string; id: string }>(
    sql`select * from app.expired_actions(${limit}::int)`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, id: row.id }));
}
