import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Removes hand-off offers that ended more than 90 days ago, across tenants (worker maintenance). */
export async function purgeConversationOffers(db: Db, batch = 5000): Promise<number> {
  const { rows } = await db.execute<{ purge_conversation_offers: string }>(
    sql`select app.purge_conversation_offers(${batch}::int)`,
  );
  return Number(rows[0]?.purge_conversation_offers ?? 0);
}
