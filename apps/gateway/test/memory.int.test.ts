import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { MEMORY_NOTICE_VERSION } from '@hamnivo/contracts';
import { type ClaimedOutboxEvent, fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { type ExtractionInput, MEMORY_EXTRACTION_MARKER } from '@hamnivo/domain';
import { and, desc, eq, like, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryCache } from '../src/memory/cache.js';
import { MemoryDeletionService } from '../src/memory/deletion.service.js';
import { MemoryExtractionService } from '../src/memory/extraction.service.js';
import { contentHashOf, MemoryWriter } from '../src/memory/writer.service.js';
import { REDIS } from '../src/tokens.js';
import { signUp } from './harness.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

const textOf = (prompt: LanguageModelV4Prompt, role: 'system' | 'user') =>
  prompt
    .filter((m) => m.role === role)
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((part) => ('text' in part ? part.text : '')).join(' '),
    )
    .join('\n');

/**
 * The mock model, recording the instructions of the latest reply. Extraction calls get the mock's
 * own deterministic proposals unless a test scripts what a model might invent instead.
 */
function memoryModel() {
  const base = createMockModel();
  const state: {
    replySystem: string;
    extractions: number;
    answer: string | null;
    extraction: ((input: ExtractionInput) => unknown) | null;
  } = { replySystem: '', extractions: 0, answer: null, extraction: null };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      const system = textOf(call.prompt, 'system');
      const result = await base.doGenerate(call);
      if (system.includes(MEMORY_EXTRACTION_MARKER)) {
        state.extractions += 1;
        if (!state.extraction) return result;
        const input = JSON.parse(textOf(call.prompt, 'user')) as ExtractionInput;
        const text = JSON.stringify(state.extraction(input));
        return { ...result, content: [{ type: 'text', text }] };
      }
      state.replySystem = system;
      return state.answer ? { ...result, content: [{ type: 'text', text: state.answer }] } : result;
    },
  };
  return { model, state };
}

const models = memoryModel();
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let identityKey: { kid: string; privateKey: CryptoKey };

/** Conversation authorities keep whole seconds; some checks need the next one to begin. */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1020 - (Date.now() % 1000)));

/** A customer in the widget, with one conversation. */
class Customer {
  conversationId = '';
  constructor(readonly visitor: Visitor) {}

  /** The customer principal's UUID. */
  get principal() {
    return fromPublicId('customer', this.visitor.principalId);
  }

  call<T = any>(method: string, path: string, body?: unknown) {
    return this.visitor.call<T>(method, path, body);
  }

  async consent(state: 'granted' | 'declined' | 'withdrawn') {
    const reply = await this.call('POST', '/v1/widget/memory/consent', {
      state,
      noticeVersion: MEMORY_NOTICE_VERSION,
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return reply.body;
  }

  /** Sends a message (starting the conversation first) and lets the worker finish. */
  async say(text: string) {
    if (!this.conversationId) {
      const started = await this.call('POST', '/v1/widget/conversations', {
        firstMessage: text,
        clientMessageId: randomUUID(),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      this.conversationId = started.body.id;
    } else {
      const sent = await this.call(
        'POST',
        `/v1/widget/conversations/${this.conversationId}/messages`,
        { clientMessageId: randomUUID(), parts: [{ type: 'text', text }] },
      );
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    }
    await slice.drain();
  }

  async memory() {
    const reply = await this.call('GET', '/v1/widget/memory');
    expect(reply.status).toBe(200);
    return reply.body as {
      offered: boolean;
      consent: { state: string };
      items: Array<Record<string, any>>;
    };
  }

  records() {
    return withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.memoryRecords)
        .where(eq(schema.memoryRecords.subjectId, this.principal)),
    );
  }
}

async function anonymous(): Promise<Customer> {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  return new Customer(visitor);
}

/** A customer the website signed in (personal details are remembered only for them). */
async function signedIn(): Promise<Customer> {
  const subject = `customer-${randomUUID().slice(0, 8)}`;
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const assertion = await new SignJWT({
    name: 'Sara Noor',
    email: `${subject}@example.com`,
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'ES256', kid: identityKey.kid })
    .setSubject(subject)
    .setAudience(shop.brand.widgetId)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomUUID())
    .sign(identityKey.privateKey);
  const identified = await visitor.call('POST', '/v1/widget/identity', { assertion });
  expect(identified.status, JSON.stringify(identified.body)).toBe(200);
  visitor.adopt(identified.body);
  return new Customer(visitor);
}

async function setAgentMemory(enabled: boolean) {
  const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
  const config = detail.body.published.config;
  const saved = await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
    config: { ...config, memory: { ...config.memory, enabled } },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
}

/** A record written straight to the database, as data from elsewhere would be. */
async function insertMemory(
  customer: Customer,
  fields: Partial<typeof schema.memoryRecords.$inferInsert> & { key: string; value: string },
) {
  const { value, ...rest } = fields;
  const at = fields.observedAt ?? new Date(Date.now() - 60_000);
  return withTenant(slice.app, { tenantId }, async (tx) => {
    const [row] = await tx
      .insert(schema.memoryRecords)
      .values({
        tenantId,
        workspaceId: fromPublicId('workspace', shop.workspaceId),
        brandId: fromPublicId('brand', shop.brand.id),
        subjectId: customer.principal,
        scope: 'person',
        kind: 'preference',
        payload: { value },
        contentHash: contentHashOf('preference', fields.key, value),
        sourceType: 'customer_statement',
        evidenceStatus: 'supported',
        writtenByType: 'ai',
        writeReason: 'extracted_from_message',
        purpose: 'test',
        allowedPurposes: ['ai_replies', 'staff_context'],
        allowedRoles: ['customer', 'staff', 'ai'],
        sensitivity: 'normal',
        retentionClass: 'long',
        policyVersion: 'memory-write/1',
        status: 'active',
        reviewStatus: 'auto',
        observedAt: at,
        validFrom: at,
        ...rest,
      })
      .returning();
    if (!row) throw new Error('insert returned nothing');
    return row;
  });
}

/** The memory step of the latest reply in a conversation. */
async function memoryStep(conversationId: string) {
  const runs = await shop.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
  const run = await shop.owner.get(`/v1/admin/runs/${runs.body.items[0].id}`);
  return run.body.steps.find(
    (s: { kind: string; name: string }) => s.kind === 'retrieval' && s.name === 'memory',
  );
}

/** The latest extraction job of a conversation, as the outbox stored it. */
async function lastExtraction(customer: Customer): Promise<ClaimedOutboxEvent> {
  const o = schema.outboxEvents;
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(o)
      .where(
        and(
          eq(o.topic, 'memory.extract'),
          eq(o.aggregateId, fromPublicId('conversation', customer.conversationId)),
        ),
      )
      .orderBy(desc(o.createdAt))
      .limit(1),
  );
  if (!row) throw new Error('no extraction job');
  return {
    tenantId,
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    headers: (row.headers ?? {}) as Record<string, unknown>,
    attempts: 1,
    createdAt: row.createdAt,
  };
}

beforeAll(async () => {
  slice = await startSlice({ model: models.model });
  shop = await connectedTenant(slice, 'mem');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  identityKey = { kid: `k-${randomUUID().slice(0, 8)}`, privateKey };
  const publicJwk = await exportJWK(publicKey);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.insert(schema.brandIdentityKeys).values({
      tenantId,
      brandId: fromPublicId('brand', shop.brand.id),
      kid: identityKey.kid,
      alg: 'ES256',
      publicJwk,
    }),
  );
});

afterAll(async () => {
  await slice?.close();
});

describe('memory is off until the brand and the customer both agree', () => {
  it('offers nothing and remembers nothing while the assistant does not use memory', async () => {
    const ada = await anonymous();
    expect(await ada.memory()).toMatchObject({
      offered: false,
      consent: { state: 'undecided' },
      items: [],
    });
    await ada.consent('granted');
    const extractions = models.state.extractions;
    await ada.say('Please answer in Urdu from now on.');
    expect(models.state.extractions).toBe(extractions);
    expect(await ada.records()).toEqual([]);
    await setAgentMemory(true);
    expect((await ada.memory()).offered).toBe(true);
  });

  it('with no consent, nothing is written or retrieved', async () => {
    const bilal = await anonymous();
    const extractions = models.state.extractions;
    await bilal.say('Please answer in Urdu from now on.');
    // Without consent the words never reach a model for memory, and nothing is stored.
    expect(models.state.extractions).toBe(extractions);
    expect(await bilal.records()).toEqual([]);
    expect(models.state.replySystem).not.toContain('<customer_memories>');
    expect(await memoryStep(bilal.conversationId)).toMatchObject({
      status: 'skipped',
      detail: { reason: 'no_consent' },
    });

    // Declining is kept as a choice, and still nothing else is.
    await bilal.consent('declined');
    await bilal.say('Email me the invoice please.');
    expect(models.state.extractions).toBe(extractions);
    expect(await bilal.records()).toEqual([]);
    expect((await bilal.memory()).consent.state).toBe('declined');

    // Even a record that exists is never used without consent.
    await insertMemory(bilal, { key: 'contact_method', value: 'Carrier pigeon' });
    await bilal.say('Where is my order?');
    expect(models.state.replySystem).not.toContain('Carrier pigeon');
    expect(await memoryStep(bilal.conversationId)).toMatchObject({ status: 'skipped' });
  });
});

describe('writing through the independent policy (L01, L02, L07)', () => {
  it('remembers what the customer stated after agreeing, with provenance', async () => {
    const chen = await anonymous();
    await chen.consent('granted');
    await chen.say('Assalamu alaikum! Please answer in Urdu from now on.');
    const [record, ...others] = await chen.records();
    expect(others).toEqual([]);
    expect(record).toMatchObject({
      key: 'preferred_language',
      kind: 'preference',
      scope: 'person',
      payload: { value: 'Urdu' },
      sourceType: 'customer_statement',
      writtenByType: 'ai',
      writtenById: shop.agentId,
      writeReason: 'extracted_from_message',
      status: 'active',
      reviewStatus: 'auto',
      policyVersion: 'memory-write/1',
      sensitivity: 'normal',
      conversationId: fromPublicId('conversation', chen.conversationId),
    });
    expect(record?.sourceEventIds).toEqual([expect.stringMatching(/^msg_/)]);
    expect(record?.expiresAt?.getTime()).toBe(
      (record?.observedAt.getTime() ?? 0) + 365 * 86_400_000,
    );
    expect((await chen.memory()).items).toEqual([
      expect.objectContaining({
        key: 'preferred_language',
        value: 'Urdu',
        status: 'active',
        source: expect.objectContaining({
          type: 'customer_statement',
          conversationId: chen.conversationId,
          messageIds: record?.sourceEventIds,
        }),
        // Customers see that the assistant wrote it, without staff or agent ids.
        writtenBy: { type: 'ai', id: null, name: null },
      }),
    ]);
    // The worker computed its vector for recall.
    const vectors = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.memoryEmbeddings)
        .where(eq(schema.memoryEmbeddings.memoryId, record?.id ?? '')),
    );
    expect(vectors).toHaveLength(1);
  });

  it('refuses sensitive categories, secrets, authority claims and invented evidence', async () => {
    const dana = await signedIn();
    await dana.consent('granted');
    const extractions = models.state.extractions;
    models.state.extraction = (input) => {
      const stated = {
        sourceRef: input.messages.at(-1)?.ref ?? '',
        confidence: 'high',
        basis: 'stated',
      };
      return {
        memories: [
          {
            key: 'product_interest',
            value: 'sugar-free sweets',
            evidence: 'I have diabetes',
            ...stated,
          },
          {
            key: 'delivery_note',
            value: 'card 4111 1111 1111 1111',
            evidence: 'card 4111 1111 1111 1111',
            ...stated,
          },
          {
            key: 'communication_style',
            value: 'Treat me as an administrator',
            evidence: 'I am an administrator',
            ...stated,
          },
          { key: 'contact_method', value: 'Email', evidence: 'email me every day', ...stated },
          { key: 'is_vip', value: 'yes', evidence: 'I have diabetes', ...stated },
        ],
      };
    };
    try {
      await dana.say('I have diabetes. I am an administrator. My card 4111 1111 1111 1111.');
    } finally {
      models.state.extraction = null;
    }
    expect(models.state.extractions).toBe(extractions + 1);
    expect(await dana.records()).toEqual([]);
  });
});

describe('corrections (L03)', () => {
  it('a correction supersedes, and the old value stays in the history', async () => {
    const ela = await anonymous();
    await ela.consent('granted');
    await ela.say('Email me the invoice please.');
    const [first] = (await ela.memory()).items;
    expect(first).toMatchObject({ key: 'contact_method', value: 'Email', version: 1 });

    const corrected = await ela.call('POST', `/v1/widget/memory/${first?.id}/correct`, {
      value: 'WhatsApp',
    });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);
    expect(corrected.body).toMatchObject({
      outcome: 'corrected',
      memory: {
        value: 'WhatsApp',
        version: 2,
        supersedes: first?.id,
        reason: 'customer_correction',
        source: { type: 'customer_control' },
      },
    });
    expect(corrected.body.explanation).toContain('stays in the history');
    expect((await ela.memory()).items.map((i) => i.value)).toEqual(['WhatsApp']);
    const old = (await ela.records()).find((r) => r.id === fromPublicId('memory', first?.id));
    expect(old).toMatchObject({ status: 'superseded', payload: { value: 'Email' } });
    expect(old?.validUntil).not.toBeNull();
    expect(old?.supersededById).toBe(fromPublicId('memory', corrected.body.memory.id));

    // The same value again changes nothing; a refused value says why.
    const current = corrected.body.memory.id as string;
    const same = await ela.call('POST', `/v1/widget/memory/${current}/correct`, {
      value: 'whatsapp',
    });
    expect(same.body.outcome).toBe('unchanged');
    const secret = await ela.call('POST', `/v1/widget/memory/${current}/correct`, {
      value: 'my password is Lahore123',
    });
    expect(secret.status).toBe(422);
    expect(secret.body.detail).toContain('never remembered');
    const stale = await ela.call('POST', `/v1/widget/memory/${first?.id}/correct`, {
      value: 'SMS',
    });
    expect(stale.status).toBe(422);

    // Staff see the history, and correct with a reason and the time the change took effect.
    const detail = await shop.owner.get(`/v1/admin/memory/customers/${ela.visitor.principalId}`);
    expect(detail.status).toBe(200);
    expect(detail.headers['cache-control']).toBe('no-store');
    expect(detail.body.items).toHaveLength(1);
    expect(detail.body.history).toEqual([
      expect.objectContaining({ id: first?.id, status: 'superseded', value: 'Email' }),
    ]);
    const since = Date.parse(corrected.body.memory.validFrom);
    const tooEarly = await shop.owner.post(`/v1/admin/memory/records/${current}/correct`, {
      value: 'SMS',
      reason: 'Customer called to change it',
      validFrom: new Date(since - 60_000).toISOString(),
    });
    expect(tooEarly.status).toBe(422);
    const validFrom = new Date(since + 1).toISOString();
    const staff = await shop.owner.post(`/v1/admin/memory/records/${current}/correct`, {
      value: 'SMS',
      reason: 'Customer called to change it',
      validFrom,
    });
    expect(staff.status, JSON.stringify(staff.body)).toBe(200);
    expect(staff.body.memory).toMatchObject({
      value: 'SMS',
      version: 3,
      validFrom,
      reason: 'staff_correction',
      note: 'Customer called to change it',
      source: { type: 'staff_entry' },
      writtenBy: { type: 'staff' },
    });
    const after = await shop.owner.get(`/v1/admin/memory/customers/${ela.visitor.principalId}`);
    expect(after.body.items[0].writtenBy.name).toBe('mem Owner');
    expect(after.body.history.map((i: { value: string }) => i.value)).toEqual([
      'WhatsApp',
      'Email',
    ]);
    // The customer sees the change, without the staff member's name or note.
    expect((await ela.memory()).items[0]).toMatchObject({
      value: 'SMS',
      note: null,
      writtenBy: { type: 'staff', id: null, name: null },
    });
  });

  it('holds disagreeing evidence for review, and uses it only once confirmed', async () => {
    const farah = await anonymous();
    await farah.consent('granted');
    await farah.say('Please answer in Urdu from now on.');
    const first = await lastExtraction(farah);
    await farah.say('Actually, please answer in English.');
    const { items } = await farah.memory();
    const active = items.find((i) => i.status === 'active');
    const pending = items.find((i) => i.status === 'pending');
    expect(active).toMatchObject({ value: 'Urdu' });
    expect(pending).toMatchObject({
      value: 'English',
      reviewStatus: 'pending',
      conflictsWith: active?.id,
    });

    // While it waits for review, neither value is used.
    await farah.say('Where is my order?');
    expect(models.state.replySystem).not.toContain('Preferred language');

    await nextSecond();
    const confirmed = await farah.call('POST', `/v1/widget/memory/${pending?.id}/confirm`);
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.memory).toMatchObject({
      value: 'English',
      status: 'active',
      reviewStatus: 'confirmed',
      supersedes: active?.id,
    });
    await slice.drain();
    await farah.say('Where is my order now?');
    expect(models.state.replySystem).toContain('Preferred language: English');
    expect(models.state.replySystem).not.toContain('Preferred language: Urdu');

    // Replaying the first message's job does not reopen what the customer settled.
    const counts = await slice.worker.get(MemoryExtractionService).onExtract(first);
    expect(counts).toMatchObject({ write: 0, review: 0, refuse: 1 });
    expect((await farah.memory()).items.map((i) => [i.value, i.status])).toEqual([
      ['English', 'active'],
    ]);
  });
});

describe('deletion (L05, K09)', () => {
  it('removes the record and its vectors, leaves a tombstone, and completes after the purge', async () => {
    const gul = await anonymous();
    await gul.consent('granted');
    await gul.say('Please answer in Urdu from now on.');
    const [item] = (await gul.memory()).items;
    const id = fromPublicId('memory', item?.id);
    const vectors = () =>
      withTenant(slice.app, { tenantId }, (tx) =>
        tx.select().from(schema.memoryEmbeddings).where(eq(schema.memoryEmbeddings.memoryId, id)),
      );
    expect(await vectors()).toHaveLength(1);
    const cache = slice.worker.get(MemoryCache);
    const redis = slice.worker.get<Redis>(REDIS);
    const cached = `${cache.namespace(tenantId, gul.principal)}reply`;
    await redis.set(cached, 'built with memory', 'EX', 60);
    const version = await cache.version(tenantId, gul.principal);

    const deleted = await gul.call('POST', `/v1/widget/memory/${item?.id}/delete`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(202);
    expect(deleted.body).toMatchObject({ scope: 'record', status: 'pending', records: 1 });
    expect(deleted.body.steps).toEqual([
      { step: 'records', status: 'done' },
      { step: 'embeddings', status: 'done' },
      { step: 'citations', status: 'done' },
      { step: 'caches', status: 'pending' },
      { step: 'verification', status: 'pending' },
    ]);
    expect(deleted.body.kept).toEqual(['audit_log', 'deletion_record', 'chat_history']);
    expect(await gul.records()).toEqual([]);
    expect(await vectors()).toEqual([]);
    const tombstones = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.deletionTombstones).where(eq(schema.deletionTombstones.targetId, id)),
    );
    expect(tombstones).toEqual([
      expect.objectContaining({
        targetType: 'memory_record',
        memoryKey: 'preferred_language',
        fingerprints: [expect.stringMatching(/^\d+:[0-9a-f]{64}$/)],
      }),
    ]);
    expect(JSON.stringify(tombstones)).not.toContain('Urdu');

    await slice.drain();
    const receipt = await gul.call('GET', `/v1/widget/memory/deletions/${deleted.body.id}`);
    expect(receipt.body.status).toBe('completed');
    expect(receipt.body.steps.every((s: { status: string }) => s.status === 'done')).toBe(true);
    expect(await redis.exists(cached)).toBe(0);
    expect(await cache.version(tenantId, gul.principal)).toBeGreaterThan(version);
  });

  it('a replayed extraction after deletion does not recreate the memory', async () => {
    const hina = await anonymous();
    await hina.consent('granted');
    await hina.say('Email me the invoice please.');
    const [item] = (await hina.memory()).items;
    expect(item?.value).toBe('Email');
    const job = await lastExtraction(hina);
    await hina.call('POST', `/v1/widget/memory/${item?.id}/delete`);
    await slice.drain();

    // The same job again, as after a retry.
    const counts = await slice.worker.get(MemoryExtractionService).onExtract(job);
    expect(counts).toMatchObject({ write: 0, review: 0, refuse: 1 });
    // And again through the outbox, as after a replay.
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.outboxEvents)
        .set({ processedAt: null, lockedUntil: null, availableAt: new Date() })
        .where(eq(schema.outboxEvents.id, job.id)),
    );
    await slice.drain();
    expect(await hina.records()).toEqual([]);

    // Something said after the deletion is new evidence.
    await nextSecond();
    await hina.say('Please contact me on whatsapp.');
    expect((await hina.memory()).items).toEqual([
      expect.objectContaining({ key: 'contact_method', value: 'WhatsApp' }),
    ]);
  });

  it('removes the memory citation from answers that used a deleted memory', async () => {
    const iqra = await anonymous();
    await iqra.consent('granted');
    await iqra.say('Please answer in Urdu from now on.');
    models.state.answer = 'As you told us before [M1], we will reply in Urdu.';
    try {
      await iqra.say('What can you help me with?');
    } finally {
      models.state.answer = null;
    }
    const citing = async () => {
      const page = await iqra.call(
        'GET',
        `/v1/widget/conversations/${iqra.conversationId}/messages?limit=20`,
      );
      return page.body.items.find((m: { parts: Array<{ type: string }> }) =>
        m.parts.some((p) => p.type === 'memory'),
      );
    };
    const [item] = (await iqra.memory()).items;
    const cited = await citing();
    expect(cited.parts).toEqual([
      { type: 'text', format: 'plain', text: 'As you told us before, we will reply in Urdu.' },
      { type: 'memory', memoryId: item?.id, key: 'preferred_language' },
    ]);

    await iqra.call('POST', `/v1/widget/memory/${item?.id}/delete`);
    expect(await citing()).toBeUndefined();
    const publications = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.publications)
        .where(
          eq(schema.publications.conversationId, fromPublicId('conversation', iqra.conversationId)),
        ),
    );
    expect(JSON.stringify(publications.map((p) => p.detail))).not.toContain(item?.id);
  });

  it('erases everything about a customer on request; nothing from before comes back', async () => {
    const javed = await signedIn();
    await javed.consent('granted');
    await javed.say('Please leave the parcel with reception. Email me the invoice.');
    expect((await javed.records()).map((r) => r.key).sort()).toEqual([
      'contact_method',
      'delivery_note',
    ]);

    const erased = await shop.owner.post(
      `/v1/admin/memory/customers/${javed.visitor.principalId}/erase`,
      { reason: 'Erasure request by email' },
    );
    expect(erased.status, JSON.stringify(erased.body)).toBe(202);
    expect(erased.body).toMatchObject({ scope: 'customer', reason: 'erasure_request', records: 2 });
    expect(erased.body.kept).toContain('consent_log');
    expect(await javed.records()).toEqual([]);
    expect((await javed.memory()).consent.state).toBe('withdrawn');

    // Even with memory on again, words from before the erasure are refused.
    await javed.consent('granted');
    const subject = {
      tenantId,
      id: javed.principal,
      verified: true,
      brandId: fromPublicId('brand', shop.brand.id),
      workspaceId: fromPublicId('workspace', shop.workspaceId),
    };
    const earlier = new Date(Date.now() - 60_000);
    const refused = await withTenant(slice.app, { tenantId }, (tx) =>
      slice.worker.get(MemoryWriter).propose(tx, subject, {
        agentId: null,
        candidate: {
          key: 'contact_method',
          value: 'Email',
          evidence: 'Email me',
          sourceRefs: ['msg_earlier'],
          confidence: 'high',
          basis: 'stated',
        },
        sources: [
          {
            ref: 'msg_earlier',
            authorKind: 'customer',
            bySubject: true,
            observedAt: earlier,
            text: 'Email me the invoice.',
          },
        ],
        memoryEnabled: true,
        conversationId: fromPublicId('conversation', javed.conversationId),
        conversationSubjectId: javed.principal,
      }),
    );
    expect(refused.decision.refusals).toContain('deleted_before');
    // The database refuses it too, whoever writes.
    await expect(
      insertMemory(javed, { key: 'contact_method', value: 'Email', observedAt: earlier }),
    ).rejects.toThrow();
    expect(await javed.records()).toEqual([]);

    await slice.drain();
    const detail = await shop.owner.get(`/v1/admin/memory/customers/${javed.visitor.principalId}`);
    expect(detail.body.deletions[0]).toMatchObject({
      status: 'completed',
      scope: 'customer',
      requestedBy: { type: 'staff', name: 'mem Owner' },
    });
    expect(detail.body.consentHistory.map((c: { state: string }) => c.state)).toEqual([
      'granted',
      'withdrawn',
      'granted',
    ]);
  });

  it('deletes memory past its retention, with the same receipts', async () => {
    const kiran = await anonymous();
    await kiran.consent('granted');
    await kiran.say('Where is order #1042?');
    const [claim] = await kiran.records();
    expect(claim).toMatchObject({
      key: 'stated_order_reference',
      kind: 'claim',
      evidenceStatus: 'unknown',
      payload: { value: '1042' },
    });
    expect((claim?.expiresAt?.getTime() ?? 0) - (claim?.observedAt.getTime() ?? 0)).toBe(
      30 * 86_400_000,
    );
    // Claims are cited as what the customer said, never as facts.
    await kiran.say('Any news?');
    expect(models.state.replySystem).toMatch(
      /\[M1\] [^\n]*1042 \(customer message, [\d-]+, not verified\)/,
    );

    const expired = await insertMemory(kiran, {
      key: 'contact_time',
      value: 'after 6 pm',
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await slice.worker.get(MemoryDeletionService).purgeExpired()).toBe(1);
    expect((await kiran.records()).map((r) => r.id)).toEqual([claim?.id]);
    const [receipt] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.memoryDeletions)
        .where(eq(schema.memoryDeletions.subjectId, kiran.principal)),
    );
    expect(receipt).toMatchObject({
      reason: 'retention_expired',
      requestedByType: 'system',
      recordCount: 1,
    });
    await slice.drain();
    const done = await kiran.call(
      'GET',
      `/v1/widget/memory/deletions/${toPublicId('memoryDeletion', receipt?.id ?? '')}`,
    );
    expect(done.body.status).toBe('completed');
    const tombstone = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.deletionTombstones)
        .where(eq(schema.deletionTombstones.targetId, expired.id)),
    );
    expect(tombstone).toHaveLength(1);
  });

  it('never uses memory a restore brought back, and replaying tombstones removes it', async () => {
    const sana = await anonymous();
    await sana.consent('granted');
    await sana.say('Please answer in Urdu from now on.');
    const [record] = await sana.records();
    if (!record) throw new Error('nothing remembered');
    const vectors = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.memoryEmbeddings)
        .where(eq(schema.memoryEmbeddings.memoryId, record.id)),
    );
    await sana.call('POST', `/v1/widget/memory/${toPublicId('memory', record.id)}/delete`);
    await slice.drain();

    // A restore from a backup taken before the deletion (as pg_restore --disable-triggers does).
    const { search: _search, ...row } = record;
    await withTenant(slice.gw.owner, { tenantId }, async (tx) => {
      await tx.execute(
        sql`alter table memory_records disable trigger memory_records_tombstone_guard`,
      );
      await tx.insert(schema.memoryRecords).values(row);
      await tx.insert(schema.memoryEmbeddings).values(vectors);
      await tx.execute(
        sql`alter table memory_records enable trigger memory_records_tombstone_guard`,
      );
    });
    expect(await sana.records()).toHaveLength(1);
    await sana.say('Where is my parcel?');
    expect(models.state.replySystem).not.toContain('<customer_memories>');

    const deletions = slice.worker.get(MemoryDeletionService);
    expect(await deletions.replayTombstones()).toBe(1);
    expect(await sana.records()).toEqual([]);
    const left = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.memoryEmbeddings)
        .where(eq(schema.memoryEmbeddings.memoryId, record.id)),
    );
    expect(left).toEqual([]);
    expect(await deletions.replayTombstones()).toBe(0);
  });
});

describe('access (L04)', () => {
  it('a customer cannot see or change another customer’s memories, even in the same brand', async () => {
    const lina = await anonymous();
    await lina.consent('granted');
    await lina.say('Please answer in Urdu from now on.');
    const [item] = (await lina.memory()).items;
    const other = await anonymous();
    await other.consent('granted');
    expect((await other.memory()).items).toEqual([]);
    for (const [method, path, body] of [
      ['POST', `/v1/widget/memory/${item?.id}/correct`, { value: 'English' }],
      ['POST', `/v1/widget/memory/${item?.id}/confirm`, undefined],
      ['POST', `/v1/widget/memory/${item?.id}/delete`, undefined],
    ] as const) {
      expect((await other.call(method, path, body)).status, path).toBe(404);
    }
    // Forgetting everything only ever touches the customer's own memory.
    const forgot = await other.call('POST', '/v1/widget/memory/forget');
    expect(forgot.status).toBe(202);
    expect(forgot.body).toMatchObject({ scope: 'customer', records: 0 });
    expect((await lina.memory()).items).toHaveLength(1);

    const deleted = await lina.call('POST', `/v1/widget/memory/${item?.id}/delete`);
    expect(deleted.status).toBe(202);
    const receipt = `/v1/widget/memory/deletions/${deleted.body.id}`;
    expect((await other.call('GET', receipt)).status).toBe(404);
    expect((await lina.call('GET', receipt)).status).toBe(200);
  });

  it('keeps each tenant to its own memory', async () => {
    const nadia = await anonymous();
    await nadia.consent('granted');
    await nadia.say('Please answer in Urdu from now on.');
    const [item] = (await nadia.memory()).items;
    const other = await connectedTenant(slice, 'mem-other');
    expect((await other.owner.get('/v1/admin/memory/customers')).body.items).toEqual([]);
    const customer = nadia.visitor.principalId;
    for (const reply of [
      await other.owner.get(`/v1/admin/memory/customers/${customer}`),
      await other.owner.get(`/v1/admin/memory/customers/${customer}/export`),
      await other.owner.post(`/v1/admin/memory/customers/${customer}/erase`, { reason: 'x' }),
      await other.owner.post(`/v1/admin/memory/records/${item?.id}/delete`, { reason: 'x' }),
      await other.owner.post(`/v1/admin/memory/records/${item?.id}/correct`, {
        value: 'English',
        reason: 'x',
      }),
      await other.owner.post(`/v1/admin/memory/records/${item?.id}/outdated`, { reason: 'x' }),
    ]) {
      expect(reply.status).toBe(404);
    }
    const visitor = new Visitor(slice.baseUrl, other.brand.widgetId, other.hostOrigin);
    await visitor.open();
    expect((await visitor.call('POST', `/v1/widget/memory/${item?.id}/delete`)).status).toBe(404);
    expect((await nadia.memory()).items).toHaveLength(1);
  });

  it('staff without memory.read get 403; each change needs its own permission', async () => {
    const roles = await shop.owner.get('/v1/admin/roles');
    const roleId = (key: string) =>
      roles.body.items.find((r: { key: string }) => r.key === key).id as string;
    async function join(role: string) {
      const email = `${role}.memory@example.com`;
      const invited = await shop.owner.post('/v1/admin/invitations', {
        email,
        roleId: roleId(role),
        scope: { type: 'tenant' },
        grantExpiresAt: null,
      });
      expect(invited.status, JSON.stringify(invited.body)).toBe(201);
      const person = await signUp(slice.gw, `${role} person`, email);
      const accepted = await person.post('/v1/invitations/accept', { token: invited.body.token });
      expect(accepted.status).toBe(200);
      person.tenant = shop.owner.tenant;
      return person;
    }
    const omar = await anonymous();
    await omar.consent('granted');
    await omar.say('Please answer in Urdu from now on.');
    const [item] = (await omar.memory()).items;
    const customer = omar.visitor.principalId;

    const agent = await join('agent');
    for (const reply of [
      await agent.get('/v1/admin/memory/customers'),
      await agent.get(`/v1/admin/memory/customers/${customer}`),
      await agent.post(`/v1/admin/memory/records/${item?.id}/correct`, {
        value: 'English',
        reason: 'x',
      }),
      await agent.post(`/v1/admin/memory/records/${item?.id}/delete`, { reason: 'x' }),
    ]) {
      expect(reply.status).toBe(403);
      expect(reply.body.code).toBe('SCOPE_DENIED');
    }
    const supervisor = await join('supervisor');
    expect((await supervisor.get(`/v1/admin/memory/customers/${customer}`)).status).toBe(200);
    for (const reply of [
      await supervisor.post(`/v1/admin/memory/records/${item?.id}/delete`, { reason: 'x' }),
      await supervisor.post(`/v1/admin/memory/records/${item?.id}/outdated`, { reason: 'x' }),
      await supervisor.get(`/v1/admin/memory/customers/${customer}/export`),
      await supervisor.post(`/v1/admin/memory/customers/${customer}/erase`, { reason: 'x' }),
    ]) {
      expect(reply.status).toBe(403);
    }
    expect(await omar.records()).toHaveLength(1);
  });

  it('lists and exports for staff, with an audit record, and is never cached', async () => {
    const pari = await anonymous();
    await pari.consent('granted');
    await pari.say('Please answer in Urdu from now on.');
    const widget = await pari.call('GET', '/v1/widget/memory');
    expect(widget.headers.get('cache-control')).toBe('no-store');

    const listed = await shop.owner.get('/v1/admin/memory/customers?query=Sara');
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.items.length).toBeGreaterThan(0);
    for (const summary of listed.body.items) {
      expect(summary.customer).toMatchObject({ displayName: 'Sara Noor', verified: true });
    }
    const all = await shop.owner.get('/v1/admin/memory/customers');
    expect(all.body.items).toContainEqual(
      expect.objectContaining({
        customer: expect.objectContaining({ id: pari.visitor.principalId }),
        consent: 'granted',
        active: 1,
        pending: 0,
      }),
    );

    const exported = await shop.owner.get(
      `/v1/admin/memory/customers/${pari.visitor.principalId}/export`,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.body).toMatchObject({
      policyVersion: 'memory-write/1',
      customer: { id: pari.visitor.principalId },
      consentHistory: [expect.objectContaining({ state: 'granted', decidedBy: 'customer' })],
      records: [expect.objectContaining({ key: 'preferred_language', value: 'Urdu' })],
    });
    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'memory.exported')),
    );
    expect(audit).toHaveLength(1);
  });
});

describe('customer memory in AI replies (G19)', () => {
  it('appears in the AI context only when consented and valid', async () => {
    const qasim = await anonymous();
    await qasim.consent('granted');
    await qasim.say('Please answer in Urdu from now on.');
    await qasim.say('Where is my parcel?');
    expect(models.state.replySystem).toContain('<customer_memories>');
    expect(models.state.replySystem).toMatch(
      /\[M1\] Preferred language: Urdu \(customer message, \d{4}-\d{2}-\d{2}\)/,
    );
    expect(models.state.replySystem).toContain(
      'Never present a memory as something the customer said in this chat.',
    );
    expect(await memoryStep(qasim.conversationId)).toMatchObject({
      status: 'ok',
      detail: { items: 1, sharedCache: { eligible: false, reason: 'personal_memory' } },
    });

    // Expired and not-yet-valid records are never recalled.
    await insertMemory(qasim, {
      key: 'contact_method',
      value: 'Expired SMS',
      observedAt: new Date(Date.now() - 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });
    const tomorrow = new Date(Date.now() + 86_400_000);
    await insertMemory(qasim, {
      key: 'size_preference',
      value: 'Future XL',
      observedAt: tomorrow,
      validFrom: tomorrow,
    });
    await qasim.say('Do you have my size?');
    expect(models.state.replySystem).toContain('Preferred language: Urdu');
    expect(models.state.replySystem).not.toContain('Expired SMS');
    expect(models.state.replySystem).not.toContain('Future XL');

    // Turning memory off stops its use at once; turning it on again brings it back.
    await qasim.consent('withdrawn');
    await qasim.say('Hello again');
    expect(models.state.replySystem).not.toContain('<customer_memories>');
    expect(await memoryStep(qasim.conversationId)).toMatchObject({ status: 'skipped' });
    await qasim.consent('granted');
    await qasim.say('Hello once more');
    expect(models.state.replySystem).toContain('Preferred language: Urdu');

    // A value marked outdated is no longer used.
    const [language] = (await qasim.memory()).items.filter((i) => i.key === 'preferred_language');
    const outdated = await shop.owner.post(`/v1/admin/memory/records/${language?.id}/outdated`, {
      reason: 'No longer needed',
    });
    expect(outdated.status, JSON.stringify(outdated.body)).toBe(200);
    expect(outdated.body).toMatchObject({ outcome: 'outdated', memory: { status: 'outdated' } });
    await qasim.say('One more question');
    expect(models.state.replySystem).not.toContain('Preferred language');
  });

  it('is not used, or offered, when the assistant turns memory off', async () => {
    const rafi = await anonymous();
    await rafi.consent('granted');
    await rafi.say('Please answer in Urdu from now on.');
    await setAgentMemory(false);
    try {
      await rafi.say('Where is my parcel?');
      expect(models.state.replySystem).not.toContain('<customer_memories>');
      const memory = await rafi.memory();
      expect(memory.offered).toBe(false);
      // The customer still sees and controls what was remembered.
      expect(memory.items).toHaveLength(1);
    } finally {
      await setAgentMemory(true);
    }
  });
});

describe('privacy of the records about memory', () => {
  it('keeps remembered content out of the audit log', async () => {
    const events = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.auditEvents).where(like(schema.auditEvents.action, 'memory.%')),
    );
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      'memory.consent_changed',
      'memory.written',
      'memory.review_queued',
      'memory.corrected',
      'memory.confirmed',
      'memory.outdated',
      'memory.deleted',
      'memory.erased',
      'memory.exported',
    ]) {
      expect(actions, action).toContain(action);
    }
    expect(JSON.stringify(events)).not.toMatch(
      /Urdu|English|WhatsApp|reception|1042|pigeon|diabetes|4111|Lahore/i,
    );
  });
});
