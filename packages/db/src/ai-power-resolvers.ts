import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Websites kept as knowledge: the worker's cross-tenant view of the sources whose next sync is due
 * (or whose last run stopped before it finished), as of the worker's clock. It returns ids only;
 * starting each sync happens in withTenant().
 */
export async function dueWebSyncs(
  db: Db,
  limit: number,
  now: Date = new Date(),
): Promise<{ tenantId: string; id: string }[]> {
  const { rows } = await db.execute<{ tenant_id: string; id: string }>(
    sql`select * from app.due_web_syncs(${limit}::int, ${now.toISOString()}::timestamptz)`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, id: row.id }));
}
