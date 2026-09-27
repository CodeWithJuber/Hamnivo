import { randomBytes, randomInt } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { appendAudit } from '../audit.js';
import type { Db } from '../client.js';
import { newId, toPublicId } from '../ids.js';
import * as s from '../schema/index.js';
import { withTenant } from '../tenant.js';

export interface SeededTenant {
  tenantId: string;
  slug: string;
  workspaceId: string;
  brandId: string;
  widgetPublicId: string;
  staffMemberId: string;
  authUserId: string;
  serviceAccountId: string;
  apiKeyPrefix: string;
  connectionId: string;
  inboxId: string;
  principalId: string;
  conversationId: string;
  sessionId: string;
  agentId: string;
  /** Version 1, published. Version 2 is a draft. */
  agentVersionId: string;
}

const bytes = (n = 32) => randomBytes(n);
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000);

/**
 * Creates a tenant with at least one row in every tenant-owned table, through the application
 * role and row-level security (as production code would). Used by the RLS test suite, which
 * fails if a new table is not seeded here.
 */
export async function seedTenant(db: Db, label = 'acme'): Promise<SeededTenant> {
  const tenantId = newId();
  const suffix = randomBytes(4).toString('hex');
  const slug = `${label}-${suffix}`;
  const authUserId = `user_${suffix}`;
  const apiKeyPrefix = `hv_test_${suffix}`;
  const widgetPublicId = toPublicId('widget', newId());
  const ids = {
    workspaceId: newId(),
    brandId: newId(),
    staffMemberId: newId(),
    serviceAccountId: newId(),
    roleId: newId(),
    secretId: newId(),
    connectionId: newId(),
    inboxId: newId(),
    botId: newId(),
    principalId: newId(),
    conversationId: newId(),
    sessionId: newId(),
    modelSecretId: newId(),
    knowledgeSourceId: newId(),
    documentId: newId(),
    documentVersionId: newId(),
    agentId: newId(),
    agentVersionId: newId(),
    runId: newId(),
    memoryId: newId(),
    memoryDeletionId: newId(),
  };

  await withTenant(db, { tenantId, actorId: 'seed' }, async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, slug, name: `${label} ${suffix}` });
    await tx
      .insert(s.workspaces)
      .values({ id: ids.workspaceId, tenantId, name: 'Main', slug: 'main' });
    await tx.insert(s.brands).values({
      id: ids.brandId,
      tenantId,
      workspaceId: ids.workspaceId,
      name: `${label} brand`,
      widgetPublicId,
      allowedOrigins: [`https://${slug}.example`],
    });
    await tx.insert(s.secrets).values({
      id: ids.secretId,
      tenantId,
      kind: 'test',
      label: 'seed secret',
      ciphertext: bytes(),
      iv: bytes(12),
      wrappedKey: bytes(40),
      kekVersion: 1,
    });
    await tx.insert(s.brandIdentityKeys).values({
      tenantId,
      brandId: ids.brandId,
      kid: 'k1',
      alg: 'HS256',
      secretId: ids.secretId,
    });
    await tx.insert(s.staffMembers).values({
      id: ids.staffMemberId,
      tenantId,
      authUserId,
      displayName: 'Sana Owner',
      email: `owner@${slug}.example`,
      status: 'active',
    });
    await tx.insert(s.roleDefinitions).values({
      id: ids.roleId,
      tenantId,
      key: 'owner',
      name: 'Owner',
      permissions: ['*'],
      isPreset: true,
    });
    await tx.insert(s.serviceAccounts).values({
      id: ids.serviceAccountId,
      tenantId,
      name: 'CI',
      createdBy: ids.staffMemberId,
    });
    await tx.insert(s.grants).values({
      tenantId,
      staffMemberId: ids.staffMemberId,
      roleId: ids.roleId,
      scopeType: 'tenant',
    });
    await tx.insert(s.invitations).values({
      tenantId,
      email: `new.agent@${slug}.example`,
      roleId: ids.roleId,
      scopeType: 'tenant',
      tokenHash: bytes(),
      invitedBy: ids.staffMemberId,
      expiresAt: inDays(7),
    });
    await tx.insert(s.apiKeys).values({
      tenantId,
      serviceAccountId: ids.serviceAccountId,
      prefix: apiKeyPrefix,
      secretHash: bytes(),
      scopes: ['conversations:read'],
    });
    await tx.insert(s.supportGrants).values({
      tenantId,
      platformUserId: 'platform_support_1',
      approvedBy: ids.staffMemberId,
      scopes: ['read'],
      reason: 'Ticket 42',
      expiresAt: inDays(1),
    });
    await tx.insert(s.customerPrincipals).values({
      id: ids.principalId,
      tenantId,
      brandId: ids.brandId,
      kind: 'verified',
      externalSubject: `customer_${suffix}`,
      displayName: 'Ayesha',
    });
    await tx.insert(s.widgetSessions).values({
      id: ids.sessionId,
      tenantId,
      brandId: ids.brandId,
      principalId: ids.principalId,
      refreshHash: bytes(),
      hostOrigin: `https://${slug}.example`,
      expiresAt: inDays(30),
    });
    await tx.insert(s.identityNonces).values({
      tenantId,
      brandId: ids.brandId,
      jti: `jti_${suffix}`,
      expiresAt: inDays(1),
    });
    await tx.insert(s.authorityConnections).values({
      id: ids.connectionId,
      tenantId,
      baseUrl: 'http://chatwoot.test',
      accountId: randomInt(1, 2_000_000_000),
      status: 'active',
      webhookSecretId: ids.secretId,
    });
    await tx.insert(s.authorityInboxes).values({
      id: ids.inboxId,
      tenantId,
      connectionId: ids.connectionId,
      brandId: ids.brandId,
      purpose: 'live',
      externalInboxId: 1,
      channelType: 'Channel::Api',
    });
    await tx.insert(s.authorityBots).values({
      id: ids.botId,
      tenantId,
      connectionId: ids.connectionId,
      externalBotId: 1,
      name: 'Hamnivo AI',
      role: 'primary',
      accessTokenSecretId: ids.secretId,
    });
    await tx.insert(s.authorityContacts).values({
      tenantId,
      connectionId: ids.connectionId,
      inboxId: ids.inboxId,
      principalId: ids.principalId,
      externalContactId: 7,
      identifier: `hv:${ids.brandId}:customer_${suffix}`,
      sourceIdCiphertext: bytes(),
      sourceIdIv: bytes(12),
      kekVersion: 1,
    });
    await tx.insert(s.staffAuthorityLinks).values({
      tenantId,
      staffMemberId: ids.staffMemberId,
      connectionId: ids.connectionId,
      externalUserId: 3,
      authorityRole: 'administrator',
    });
    await tx.insert(s.conversationControls).values({
      id: ids.conversationId,
      tenantId,
      connectionId: ids.connectionId,
      inboxId: ids.inboxId,
      brandId: ids.brandId,
      principalId: ids.principalId,
      externalConversationId: 11,
      ownerMode: 'AI_ACTIVE',
      ownerBotId: ids.botId,
      authorityStatus: 'pending',
      journalSeq: 1,
    });
    await tx.insert(s.messageLedger).values({
      tenantId,
      conversationId: ids.conversationId,
      senderKind: 'customer',
      senderId: ids.principalId,
      clientMessageId: newId(),
      requestHash: bytes(),
      sourceKey: `hv1:m:${newId()}`,
      state: 'committed',
    });
    await tx.insert(s.publications).values({
      tenantId,
      conversationId: ids.conversationId,
      epoch: 0,
      sourceKey: `hv1:p:${newId()}`,
      contentHash: bytes(),
    });
    await tx.insert(s.integrationInbox).values({
      tenantId,
      connectionId: ids.connectionId,
      source: 'account',
      dedupeKey: `msg:1:${suffix}`,
      eventType: 'message_created',
      payload: { id: 1 },
    });
    await tx.insert(s.conversationJournal).values({
      tenantId,
      conversationId: ids.conversationId,
      seq: 1,
      lane: 'customer',
      eventType: 'message.created',
      event: { text: 'Assalamu alaikum' },
      expiresAt: inDays(7),
    });
    await tx.insert(s.conversationFeedback).values({
      tenantId,
      conversationId: ids.conversationId,
      principalId: ids.principalId,
      rating: 5,
      comment: 'Very helpful',
    });
    await tx.insert(s.reconcileCursors).values({
      tenantId,
      connectionId: ids.connectionId,
      scope: 'conversation',
      scopeRef: '11',
    });
    await tx.insert(s.outboxEvents).values({
      tenantId,
      topic: 'conversation.owner_changed',
      aggregateType: 'conversation',
      aggregateId: ids.conversationId,
      payload: { epoch: 0 },
    });
    await tx.insert(s.processedEvents).values({ tenantId, consumer: 'seed', eventId: newId() });
    await tx.insert(s.idempotencyKeys).values({
      tenantId,
      scope: 'POST /v1/widget/conversations',
      key: `idem_${suffix}`,
      requestHash: bytes(),
      expiresAt: inDays(1),
    });
    await tx.insert(s.usageEntries).values({
      tenantId,
      meter: 'ai.tokens',
      quantity: 120,
      unit: 'token',
      occurredAt: new Date(),
      dedupeKey: `run_${suffix}`,
    });
    await tx.insert(s.secrets).values({
      id: ids.modelSecretId,
      tenantId,
      kind: 'model_api_key',
      label: 'Model key',
      hint: 'abcd',
      ciphertext: bytes(),
      iv: bytes(12),
      wrappedKey: bytes(),
      kekVersion: 1,
    });
    await tx.insert(s.modelConnections).values({
      tenantId,
      provider: 'openai-compatible',
      label: 'Local models',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKeySecretId: ids.modelSecretId,
    });
    await tx.insert(s.agentProfiles).values({
      id: ids.agentId,
      tenantId,
      workspaceId: ids.workspaceId,
      brandId: ids.brandId,
      name: 'Support assistant',
      isDefault: true,
    });
    await tx.insert(s.agentVersions).values({
      id: ids.agentVersionId,
      tenantId,
      profileId: ids.agentId,
      version: 1,
      state: 'published',
      config: { displayName: 'Assistant', model: { provider: 'mock', modelId: 'hamnivo-mock' } },
      configHash: bytes(),
      publishedAt: new Date(),
    });
    await tx.insert(s.agentVersions).values({
      tenantId,
      profileId: ids.agentId,
      version: 2,
      state: 'draft',
      config: { displayName: 'Assistant', model: { provider: 'mock', modelId: 'hamnivo-mock' } },
    });
    await tx.insert(s.knowledgeSources).values({
      id: ids.knowledgeSourceId,
      tenantId,
      workspaceId: ids.workspaceId,
      brandId: ids.brandId,
      name: 'Help centre',
    });
    await tx.insert(s.knowledgeDocuments).values({
      id: ids.documentId,
      tenantId,
      sourceId: ids.knowledgeSourceId,
      title: 'Returns',
    });
    await tx.insert(s.documentVersions).values({
      id: ids.documentVersionId,
      tenantId,
      documentId: ids.documentId,
      version: 1,
      state: 'ready',
      mediaType: 'text/markdown',
      byteSize: 40,
      contentHash: bytes(),
      text: 'You can return items within 30 days.',
      readyAt: new Date(),
    });
    await tx
      .update(s.knowledgeDocuments)
      .set({ currentVersionId: ids.documentVersionId })
      .where(eq(s.knowledgeDocuments.id, ids.documentId));
    await tx.insert(s.knowledgeChunks).values({
      tenantId,
      versionId: ids.documentVersionId,
      documentId: ids.documentId,
      sourceId: ids.knowledgeSourceId,
      seq: 0,
      heading: 'Returns',
      text: 'You can return items within 30 days.',
      tokens: 9,
    });
    await tx.insert(s.killSwitches).values({
      tenantId,
      scope: 'agent',
      agentId: ids.agentId,
      reason: 'Seeded and cleared',
      clearedAt: new Date(),
    });
    await tx.insert(s.runs).values({
      id: ids.runId,
      tenantId,
      conversationId: ids.conversationId,
      brandId: ids.brandId,
      agentId: ids.agentId,
      agentVersionId: ids.agentVersionId,
      triggerRef: `reply:${suffix}`,
      kind: 'reply',
      state: 'succeeded',
      outcome: 'replied',
      epoch: 0,
    });
    await tx.insert(s.runSteps).values({
      tenantId,
      runId: ids.runId,
      seq: 0,
      kind: 'model',
      name: 'generate',
      status: 'ok',
    });
    await tx.insert(s.learningConsents).values({
      tenantId,
      brandId: ids.brandId,
      subjectId: ids.principalId,
      scope: 'personal_memory',
      state: 'granted',
      noticeVersion: 'memory-notice/1',
      actorType: 'customer',
    });
    const observedAt = new Date(Date.now() - 3_600_000);
    await tx.insert(s.memoryRecords).values({
      id: ids.memoryId,
      tenantId,
      workspaceId: ids.workspaceId,
      brandId: ids.brandId,
      subjectId: ids.principalId,
      conversationId: ids.conversationId,
      scope: 'person',
      kind: 'preference',
      key: 'preferred_language',
      payload: { value: 'Urdu' },
      contentHash: bytes(),
      sourceType: 'customer_statement',
      sourceEventIds: ['msg_seed'],
      evidenceStatus: 'supported',
      writtenByType: 'ai',
      writeReason: 'extracted_from_message',
      purpose: 'Reply in the language the customer prefers',
      allowedPurposes: ['ai_replies', 'staff_context'],
      allowedRoles: ['customer', 'staff', 'ai'],
      sensitivity: 'normal',
      retentionClass: 'long',
      expiresAt: inDays(365),
      policyVersion: 'memory-write/1',
      status: 'active',
      reviewStatus: 'auto',
      observedAt,
      validFrom: observedAt,
    });
    await tx.insert(s.memoryEmbeddings).values({
      tenantId,
      memoryId: ids.memoryId,
      subjectId: ids.principalId,
      embedding: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
      embeddingModel: 'hamnivo:seed',
      contentHash: bytes(),
    });
    await tx.insert(s.memoryDeletions).values({
      id: ids.memoryDeletionId,
      tenantId,
      brandId: ids.brandId,
      subjectId: ids.principalId,
      scope: 'record',
      reason: 'customer_request',
      requestedByType: 'customer',
      recordCount: 1,
      status: 'completed',
      steps: { records: 'done', embeddings: 'done', caches: 'done' },
      completedAt: new Date(),
    });
    await tx.insert(s.deletionTombstones).values({
      tenantId,
      deletionId: ids.memoryDeletionId,
      subjectId: ids.principalId,
      targetType: 'memory_record',
      targetId: newId(),
      memoryKey: 'delivery_note',
      sourceEventIds: ['msg_seed_deleted'],
      observedAt,
    });
    // Staff inbox: a team, a second conversation linked to the first, drafts and a review.
    const teamId = newId();
    await tx
      .insert(s.teams)
      .values({ id: teamId, tenantId, name: 'Billing', createdBy: ids.staffMemberId });
    await tx.insert(s.teamMembers).values({ tenantId, teamId, staffMemberId: ids.staffMemberId });
    await tx.insert(s.teamAuthorityLinks).values({
      tenantId,
      teamId,
      connectionId: ids.connectionId,
      externalTeamId: 5,
    });
    await tx.insert(s.conversationInboxState).values({
      tenantId,
      conversationId: ids.conversationId,
      teamId,
      labels: ['delivery'],
    });
    const otherConversationId = newId();
    await tx.insert(s.conversationControls).values({
      id: otherConversationId,
      tenantId,
      connectionId: ids.connectionId,
      inboxId: ids.inboxId,
      brandId: ids.brandId,
      principalId: ids.principalId,
      externalConversationId: 12,
      ownerMode: 'HUMAN_ACTIVE',
      ownerStaffId: ids.staffMemberId,
      ownerReason: 'staff_takeover',
      ownerChangedAt: new Date(),
      // Resolved, so the reconciler tests still see one conversation to follow per tenant.
      authorityStatus: 'resolved',
    });
    // Links are stored once per pair, smaller id first (UUIDs compare like their hex text).
    const [low, high] = [ids.conversationId, otherConversationId].sort() as [string, string];
    await tx.insert(s.conversationLinks).values({
      tenantId,
      conversationId: low,
      linkedConversationId: high,
      note: 'Same order',
      createdBy: ids.staffMemberId,
    });
    await tx.insert(s.staffDrafts).values([
      {
        tenantId,
        conversationId: ids.conversationId,
        staffMemberId: ids.staffMemberId,
        lane: 'internal',
        kind: 'draft',
        text: 'Courier delayed',
      },
      {
        tenantId,
        conversationId: ids.conversationId,
        staffMemberId: ids.staffMemberId,
        lane: 'public',
        kind: 'outgoing',
        text: 'I am checking your order now.',
        clientMessageId: newId(),
        state: 'failed',
        errorCode: 'AUTHORITY_UNAVAILABLE',
      },
    ]);
    await tx.insert(s.conversationReviews).values({
      tenantId,
      conversationId: ids.conversationId,
      reviewerId: ids.staffMemberId,
      subjectStaffId: ids.staffMemberId,
      rating: 4,
      note: 'Clear and kind.',
    });
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'seed',
      action: 'tenant.created',
      targetType: 'tenant',
      targetId: tenantId,
      outcome: 'success',
    });
  });

  return {
    tenantId,
    slug,
    workspaceId: ids.workspaceId,
    brandId: ids.brandId,
    widgetPublicId,
    staffMemberId: ids.staffMemberId,
    authUserId,
    serviceAccountId: ids.serviceAccountId,
    apiKeyPrefix,
    connectionId: ids.connectionId,
    inboxId: ids.inboxId,
    principalId: ids.principalId,
    conversationId: ids.conversationId,
    sessionId: ids.sessionId,
    agentId: ids.agentId,
    agentVersionId: ids.agentVersionId,
  };
}
