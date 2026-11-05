import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Removes AI drafts (and their decisions) that ended more than 90 days ago, across tenants. */
export async function purgeAiDrafts(db: Db, batch = 5000): Promise<number> {
  const { rows } = await db.execute<{ purge_ai_drafts: string }>(
    sql`select app.purge_ai_drafts(${batch}::int)`,
  );
  return Number(rows[0]?.purge_ai_drafts ?? 0);
}
