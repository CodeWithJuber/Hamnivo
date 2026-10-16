import { sql } from 'drizzle-orm';
import type { Db } from './client.js';
import type { TenantTx } from './tenant.js';

/** A resolved conversation older than its workspace's retention period (A10). */
export interface RetentionDue {
  tenantId: string;
  conversationId: string;
  connectionId: string;
  externalConversationId: number;
  lastActivityAt: Date;
  /** The database's cutoff: activity before it is old enough to delete. */
  cutoff: Date;
}

/**
 * Old resolved conversations of every workspace whose retention is on, oldest first and at most
 * `perTenant` per workspace; changes that waited out their grace take effect first.
 */
export async function retentionDue(db: Db, limit = 100, perTenant = 25): Promise<RetentionDue[]> {
  const { rows } = await db.execute<{
    tenant_id: string;
    conversation_id: string;
    connection_id: string;
    external_conversation_id: number;
    last_activity_at: Date | string;
    cutoff: Date | string;
  }>(sql`select * from app.retention_due(${limit}::int, ${perTenant}::int)`);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    conversationId: row.conversation_id,
    connectionId: row.connection_id,
    externalConversationId: Number(row.external_conversation_id),
    lastActivityAt: new Date(row.last_activity_at),
    cutoff: new Date(row.cutoff),
  }));
}

/** Workspaces whose retention is on, and the database's cutoff for each. */
export async function retentionTenants(db: Db): Promise<{ tenantId: string; cutoff: Date }[]> {
  const { rows } = await db.execute<{ tenant_id: string; cutoff: Date | string }>(
    sql`select * from app.retention_tenants()`,
  );
  return rows.map((row) => ({ tenantId: row.tenant_id, cutoff: new Date(row.cutoff) }));
}

/**
 * Deletes a conversation of the transaction's tenant and its records, keeping the anonymous report
 * row, if it is still resolved and older than the retention period. True when it went.
 */
export async function retireConversation(tx: TenantTx, conversationId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ retired: boolean }>(
    sql`select app.retire_conversation(${conversationId}::uuid) as retired`,
  );
  return rows[0]?.retired === true;
}

/** Customers of the transaction's tenant that retention removes, oldest first. */
export async function retentionOrphans(
  tx: TenantTx,
  limit = 100,
): Promise<{ principalId: string; brandId: string }[]> {
  const { rows } = await tx.execute<{ principal_id: string; brand_id: string }>(
    sql`select * from app.retention_orphans(${limit}::int)`,
  );
  return rows.map((row) => ({ principalId: row.principal_id, brandId: row.brand_id }));
}

/** Removes a customer whom retention may remove, once their memory is gone. True when they went. */
export async function retireCustomer(tx: TenantTx, principalId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ retired: boolean }>(
    sql`select app.retire_customer(${principalId}::uuid) as retired`,
  );
  return rows[0]?.retired === true;
}

/** Removes outbox events handled more than 30 days ago, across tenants. */
export async function purgeOutboxEvents(db: Db, batch = 5000): Promise<number> {
  const { rows } = await db.execute<{ removed: string }>(
    sql`select app.purge_outbox_events(${batch}::int) as removed`,
  );
  return Number(rows[0]?.removed ?? 0);
}
