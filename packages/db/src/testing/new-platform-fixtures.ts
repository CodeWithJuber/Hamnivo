import { eq } from 'drizzle-orm';
import { newId } from '../ids.js';
import * as s from '../schema/index.js';
import type { TenantTx } from '../tenant.js';

/** New tenant-owned features exercised by the exhaustive two-tenant RLS suite. */
export async function seedNewPlatformTables(
  tx: TenantTx,
  tenantId: string,
  suffix: string,
  ref: {
    workspaceId: string;
    brandId: string;
    secretId: string;
    staffMemberId: string;
    principalId: string;
    conversationId: string;
    agentId: string;
    agentVersionId: string;
    runId: string;
  },
): Promise<void> {
  const [identityKey] = await tx
    .select({ id: s.brandIdentityKeys.id })
    .from(s.brandIdentityKeys)
    .where(eq(s.brandIdentityKeys.brandId, ref.brandId));
  const [tool] = await tx
    .select({ id: s.toolDefinitions.id })
    .from(s.toolDefinitions)
    .where(eq(s.toolDefinitions.name, 'order_status'));
  if (!identityKey || !tool)
    throw new Error('seedNewPlatformTables requires identity key and tool');

  await tx.insert(s.tenantBranding).values({
    tenantId,
    portal: {
      displayName: 'Seeded tenant',
      logoUrl: null,
      faviconUrl: null,
      accentColor: '#275dad',
      fontFamily: 'system',
      showBranding: true,
    },
    email: { senderName: null, replyTo: null, logoUrl: null },
  });
  await tx.insert(s.brandingDomains).values({
    tenantId,
    hostname: `portal-${suffix}.example`,
    verificationToken: `verify-${suffix}`,
  });

  const connectionId = newId();
  await tx.insert(s.connectorConnections).values({
    id: connectionId,
    tenantId,
    workspaceId: ref.workspaceId,
    brandId: ref.brandId,
    kind: 'whmcs',
    label: 'Seed WHMCS',
    baseUrl: `https://whmcs-${suffix}.example/`,
    identifierSecretId: ref.secretId,
    tokenSecretId: ref.secretId,
    identityKeyId: identityKey.id,
    createdBy: ref.staffMemberId,
  });
  await tx.insert(s.connectorToolGrants).values({
    tenantId,
    connectionId,
    toolId: tool.id,
    capability: 'invoices.read',
    version: 1,
  });
  await tx.insert(s.connectorIdentityBindings).values({
    tenantId,
    brandId: ref.brandId,
    connectionId,
    principalId: ref.principalId,
    userId: 42,
    clientId: 21,
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await tx.insert(s.connectorQuotes).values({
    tenantId,
    connectionId,
    principalId: ref.principalId,
    conversationId: ref.conversationId,
    fingerprint: `quote-${suffix}`,
    price: '12.00',
    expiresAt: new Date(Date.now() + 300_000),
  });
  await tx.insert(s.connectorDispatches).values({
    tenantId,
    connectionId,
    principalId: ref.principalId,
    fingerprint: `dispatch-${suffix}`,
    idempotencyKey: `dispatch-${suffix}`,
    state: 'confirmed',
  });

  const workflowId = newId();
  const versionId = newId();
  await tx.insert(s.workflows).values({
    id: workflowId,
    tenantId,
    brandId: ref.brandId,
    name: 'Seeded workflow',
    draft: { steps: [] },
  });
  await tx.insert(s.workflowVersions).values({
    id: versionId,
    tenantId,
    workflowId,
    version: 1,
    name: 'Seeded workflow',
    definition: { steps: [] },
  });
  await tx
    .update(s.workflows)
    .set({ publishedVersionId: versionId })
    .where(eq(s.workflows.id, workflowId));
  await tx.insert(s.a2aConnections).values({
    tenantId,
    brandId: ref.brandId,
    name: 'Seed specialist',
    endpoint: `https://specialist-${suffix}.example/a2a`,
  });
  const workflowRunId = newId();
  await tx.insert(s.workflowRuns).values({
    id: workflowRunId,
    tenantId,
    brandId: ref.brandId,
    workflowId,
    versionId,
    conversationId: ref.conversationId,
    runtimeRunId: ref.runId,
    agentId: ref.agentId,
    agentVersionId: ref.agentVersionId,
    eventKey: `seed-${suffix}`,
    epoch: 0,
    deadline: new Date(Date.now() + 300_000),
  });
  await tx.insert(s.workflowRunSteps).values({
    tenantId,
    runId: workflowRunId,
    stepId: 'seed-step',
    type: 'condition',
    state: 'completed',
  });

  await tx.insert(s.aiCreditAttempts).values({
    tenantId,
    payerTenantId: tenantId,
    attemptKey: `seed-${suffix}`,
    source: 'managed',
    status: 'reserved',
    provider: 'mock',
    modelId: 'hamnivo-mock',
    periodKey: '2026-10',
    reservedTokens: 10,
    leaseToken: newId(),
    expiresAt: new Date(Date.now() + 300_000),
  });
}
