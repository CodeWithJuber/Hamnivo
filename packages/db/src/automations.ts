import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Removes chat automation runs older than 90 days, across tenants (worker maintenance). */
export async function purgeAutomationRuns(db: Db, batch = 5000): Promise<number> {
  const { rows } = await db.execute<{ purge_automation_runs: string }>(
    sql`select app.purge_automation_runs(${batch}::int)`,
  );
  return Number(rows[0]?.purge_automation_runs ?? 0);
}
