import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { Db } from './client.js';

export type TenantTx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface TenantContext {
  tenantId: string;
  /** Staff member, service account or system actor id, recorded as `app.actor_id`. */
  actorId?: string | null;
  /** Per-transaction statement timeout (default 10 s). */
  statementTimeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  override name = 'TenantContextError';
}

/**
 * Runs `work` in a transaction bound to one tenant. Row-level security then limits every query
 * to that tenant's rows; the setting is transaction-local, so it cannot leak to the next user of
 * the pooled connection. All tenant data access goes through this function.
 */
export async function withTenant<T>(
  db: Db,
  context: TenantContext,
  work: (tx: TenantTx) => Promise<T>,
  config?: PgTransactionConfig,
): Promise<T> {
  if (!UUID.test(context.tenantId)) {
    throw new TenantContextError('withTenant requires a tenant UUID');
  }
  const timeout = Math.max(1, Math.trunc(context.statementTimeoutMs ?? 10_000));
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.tenant_id', ${context.tenantId}, true),
        set_config('app.actor_id', ${context.actorId ?? ''}, true),
        set_config('statement_timeout', ${String(timeout)}, true)`);
    return work(tx);
  }, config);
}
