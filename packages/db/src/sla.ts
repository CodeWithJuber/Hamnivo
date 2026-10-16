import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Removes reply-time outcomes whose clock ended more than 13 months ago, across tenants. */
export async function purgeSlaOutcomes(db: Db, batch = 5000): Promise<number> {
  const { rows } = await db.execute<{ purge_sla_outcomes: string }>(
    sql`select app.purge_sla_outcomes(${batch}::int)`,
  );
  return Number(rows[0]?.purge_sla_outcomes ?? 0);
}
