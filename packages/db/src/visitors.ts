import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Removes page views, visits and visitors not seen for 30 days (an audited SECURITY DEFINER
 * function across tenants, like the other maintenance purges). One call removes at most `batch`
 * rows of each kind; the worker calls it every ten minutes, so it keeps up.
 */
export async function purgeVisitors(
  db: Db,
  batch = 5000,
): Promise<{ pageViews: number; sessions: number; visitors: number }> {
  const { rows } = await db.execute<{
    page_views_removed: string;
    sessions_removed: string;
    visitors_removed: string;
  }>(sql`select * from app.purge_visitors(${batch}::int)`);
  const row = rows[0];
  return {
    pageViews: Number(row?.page_views_removed ?? 0),
    sessions: Number(row?.sessions_removed ?? 0),
    visitors: Number(row?.visitors_removed ?? 0),
  };
}
