import { schema, type TenantTx } from '@hamnivo/db';
import type { BillingProviderKind } from '@hamnivo/db/schema';
import { eq } from 'drizzle-orm';
import type { AccountState } from './lifecycle.js';

export type AccountRow = typeof schema.billingAccounts.$inferSelect;

/**
 * The workspace's billing account, created on first use. With `lock`, the row is held for the
 * rest of the transaction, so provider events for one workspace apply one after the other.
 */
export async function billingAccount(
  tx: TenantTx,
  tenantId: string,
  options: { lock?: boolean; provider?: BillingProviderKind } = {},
): Promise<AccountRow> {
  await tx
    .insert(schema.billingAccounts)
    .values({ tenantId, provider: options.provider ?? 'free' })
    .onConflictDoNothing({ target: schema.billingAccounts.tenantId });
  const query = tx.select().from(schema.billingAccounts);
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new Error('billing account missing after insert');
  return row;
}

export function accountState(row: AccountRow): AccountState {
  return {
    subscriptionStatus: row.subscriptionStatus,
    planKey: row.planKey,
    paymentFailedAt: row.paymentFailedAt,
    graceEndsAt: row.graceEndsAt,
  };
}

export async function updateAccount(
  tx: TenantTx,
  row: AccountRow,
  values: Partial<typeof schema.billingAccounts.$inferInsert>,
): Promise<void> {
  await tx
    .update(schema.billingAccounts)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.billingAccounts.id, row.id));
}
