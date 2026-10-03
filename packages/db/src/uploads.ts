import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/**
 * Clears the bytes of widget uploads whose time in quarantine ended without being sent, and
 * removes upload records older than 30 days (W09). Runs across tenants through an audited
 * SECURITY DEFINER function, like the other maintenance purges.
 */
export async function purgeWidgetUploads(
  db: Db,
  batch = 1000,
): Promise<{ expired: number; removed: number }> {
  const { rows } = await db.execute<{ expired: string; removed: string }>(
    sql`select * from app.purge_widget_uploads(${batch}::int)`,
  );
  return { expired: Number(rows[0]?.expired ?? 0), removed: Number(rows[0]?.removed ?? 0) };
}
