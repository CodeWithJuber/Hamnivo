import type { TenantTx } from '@hamnivo/db';
import { sql } from 'drizzle-orm';

/**
 * Serializes memory changes for one customer until the transaction ends: writes, corrections,
 * confirmations and deletions of the same customer never interleave.
 */
export async function lockMemorySubject(
  tx: TenantTx,
  tenantId: string,
  subjectId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${tenantId}:${subjectId}`}, 0))`,
  );
}
