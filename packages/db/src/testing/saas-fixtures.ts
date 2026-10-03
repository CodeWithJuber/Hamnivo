import * as s from '../schema/index.js';
import type { TenantTx } from '../tenant.js';

/**
 * SaaS rows for the RLS suite: a Stripe billing account, one applied billing event, a brand's
 * finished Chatwoot set-up and the workspace's email sender name.
 */
export async function seedSaas(
  tx: TenantTx,
  tenantId: string,
  suffix: string,
  ref: { brandId: string; connectionId: string; staffMemberId: string },
): Promise<void> {
  const now = new Date();
  await tx.insert(s.billingAccounts).values({
    tenantId,
    provider: 'stripe',
    customerRef: `cus_seed_${suffix}`,
    subscriptionRef: `sub_seed_${suffix}`,
    subscriptionStatus: 'active',
    planKey: 'team',
    currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
    providerUpdatedAt: now,
  });
  await tx.insert(s.billingEvents).values({
    tenantId,
    provider: 'stripe',
    eventId: `evt_seed_${suffix}`,
    type: 'customer.subscription.created',
    occurredAt: now,
    outcome: 'applied',
    detail: { status: 'active', plan: 'team' },
  });
  await tx.insert(s.chatwootProvisioning).values({
    tenantId,
    brandId: ref.brandId,
    connectionId: ref.connectionId,
    state: 'connected',
    step: 'done',
    attempts: 1,
    trigger: 'brand.created',
    startedAt: now,
    finishedAt: now,
  });
  await tx.insert(s.workspaceEmailSettings).values({
    tenantId,
    senderName: `Seed ${suffix}`,
    updatedBy: ref.staffMemberId,
  });
}
