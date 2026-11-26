import { randomUUID } from 'node:crypto';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * The assistant answers for real (production's rules, ALLOW_MOCK_MODEL=false): the offline test
 * model, which gives every customer the same fixed reply, is never published there and never
 * answers; "Make the assistant live" moves the brand's agent to a real model, its knowledge and
 * memory in one step; a brand's website becomes its AI's knowledge without setup.
 */
type Shop = Awaited<ReturnType<typeof connectedTenant>>;

async function conversation(slice: Slice, shop: Shop, text: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: text,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await slice.drain();
  return started.body.id as string;
}

async function inspect(slice: Slice, shop: Shop, conversationId: string) {
  const [control] = await withTenant(
    slice.app,
    { tenantId: fromPublicId('tenant', shop.tenantId) },
    (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(fromPublicId('tenant', shop.tenantId), fromPublicId('connection', shop.connection.id));
  const messages = await runtime.authority.listMessages(String(control.externalConversationId), {
    view: 'staff',
  });
  return {
    control,
    botReplies: messages.filter((m) => m.sender.kind === 'bot' && !m.private).map((m) => m.text),
    notes: messages.filter((m) => m.private).map((m) => m.text ?? ''),
  };
}

const addKey = (shop: Shop) =>
  shop.owner.post('/v1/admin/model-connections', {
    provider: 'openai',
    label: 'Team key',
    apiKey: 'sk-test-0123456789abcd',
    allowedModels: ['gpt-5.4-mini'],
  });

describe('production without a key of its own', () => {
  let slice: Slice;
  let shop: Shop;

  beforeAll(async () => {
    slice = await startSlice({ env: { ALLOW_MOCK_MODEL: 'false' } });
    shop = await connectedTenant(slice, 'golive', { publishAgent: false });
  });

  afterAll(async () => {
    await slice?.close();
  });

  it('never publishes the test model, and says what to do instead', async () => {
    const draft = (await shop.owner.get(`/v1/admin/agents/${shop.agentId}`)).body.draft;
    expect(draft.config.model).toEqual({ provider: 'mock', modelId: 'hamnivo-mock' });
    const refused = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toMatch(/test model gives every customer the same fixed reply/);
    expect(refused.body.fields[0].path).toBe('config.model');
    const noKey = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {});
    expect(noKey.status).toBe(422);
    expect(noKey.body.detail).toMatch(/Add an AI key/);
  });

  it('hands a conversation to people when the test model was published before', async () => {
    // As an agent published before production refused it: the published version is the mock.
    await withTenant(slice.app, { tenantId: fromPublicId('tenant', shop.tenantId) }, async (tx) => {
      const profileId = fromPublicId('agent', shop.agentId);
      const [version] = await tx
        .update(schema.agentVersions)
        .set({ state: 'published', publishedAt: new Date(), configHash: Buffer.from('mock') })
        .where(eq(schema.agentVersions.profileId, profileId))
        .returning();
      await tx
        .update(schema.agentProfiles)
        .set({ publishedVersionId: version?.id ?? null })
        .where(eq(schema.agentProfiles.id, profileId));
    });
    const id = await conversation(slice, shop, 'Where is my order 1042?');
    const seen = await inspect(slice, shop, id);
    expect(seen.control.ownerMode).not.toBe('AI_ACTIVE');
    expect(seen.control.ownerReason).toBe('no_live_model');
    // No fixed reply went to the customer; people are told why, and what fixes it.
    expect(seen.botReplies).toEqual([]);
    expect(seen.notes.join('\n')).toMatch(/test model.*Make the assistant live/s);
  });

  it('makes the assistant live on the key the workspace added, with memory on', async () => {
    const key = await addKey(shop);
    expect(key.status, JSON.stringify(key.body)).toBe(201);
    const live = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {});
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    const config = live.body.published.config;
    expect(config.model).toEqual({
      provider: 'openai',
      modelId: 'gpt-5.4-mini',
      connectionId: key.body.id,
    });
    expect(config.memory.enabled).toBe(true);
    expect(config.mode).toBe('answer');
    expect(live.body.draft).toBeNull();
    const audit = await shop.owner.get('/v1/admin/audit?action=agent.published');
    expect(audit.body.items[0].data).toMatchObject({
      wentLive: true,
      model: 'openai/gpt-5.4-mini',
    });
  });
});

describe('a server with its own AI key', () => {
  let slice: Slice;
  let shop: Shop;
  /** A real model stands in: each question gets its own answer. */
  // It never calls a tool: the assistant's actions are tested in assistant-actions.int.
  const model = createMockModel({
    reply: ({ text }) => `You asked: ${text.slice(0, 40)}`,
    tools: false,
  });

  beforeAll(async () => {
    slice = await startSlice({
      model,
      env: { ALLOW_MOCK_MODEL: 'false', ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' },
    });
    shop = await connectedTenant(slice, 'platform', { publishAgent: false });
  });

  afterAll(async () => {
    await slice?.close();
  });

  it('starts a new brand on the platform’s model, not the test model', async () => {
    const draft = (await shop.owner.get(`/v1/admin/agents/${shop.agentId}`)).body.draft;
    expect(draft.config.model).toEqual({ provider: 'anthropic', modelId: 'claude-haiku-5-5' });
  });

  it('reads the brand’s website without setup, once, and never a test address', async () => {
    const sources = () => shop.owner.get('/v1/admin/knowledge/web-sources');
    // `https://platform.example` is a reserved test name: nothing to read.
    expect((await sources()).body.items).toEqual([]);
    const added = await shop.owner.patch(`/v1/admin/brands/${shop.brand.id}`, {
      allowedOrigins: [shop.hostOrigin, 'https://noorbooks.com', 'http://localhost:3000'],
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const listed = (await sources()).body.items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ url: 'https://noorbooks.com/', visibility: 'public' });
    // Another website later is the owner's to add: the brand already has its website.
    await shop.owner.patch(`/v1/admin/brands/${shop.brand.id}`, {
      allowedOrigins: [shop.hostOrigin, 'https://noorbooks.com', 'https://shop.noorbooks.com'],
    });
    expect((await sources()).body.items).toHaveLength(1);
  });

  it('goes live in one step, with the website, and then answers each question itself', async () => {
    const live = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {});
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    const config = live.body.published.config;
    expect(config.model).toEqual({ provider: 'anthropic', modelId: 'claude-haiku-5-5' });
    expect(config.knowledgeSourceIds).toHaveLength(1);
    expect(config.memory.enabled).toBe(true);
    const first = await conversation(slice, shop, 'Do you ship to Lahore?');
    const second = await conversation(slice, shop, 'Can I pay cash on delivery?');
    const one = await inspect(slice, shop, first);
    const two = await inspect(slice, shop, second);
    expect(one.control.ownerMode).toBe('AI_ACTIVE');
    expect(one.botReplies.join(' ')).toContain('Do you ship to Lahore?');
    expect(two.botReplies.join(' ')).toContain('Can I pay cash on delivery?');
  });

  it('keeps the model it has when asked again, and takes a key it is given', async () => {
    const again = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {});
    expect(again.status).toBe(200);
    expect(again.body.published.config.model.provider).toBe('anthropic');
    const key = await addKey(shop);
    const moved = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {
      connectionId: key.body.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.published.config.model).toMatchObject({
      provider: 'openai',
      connectionId: key.body.id,
    });
    const versions = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', shop.tenantId) },
      (tx) =>
        tx
          .select()
          .from(schema.agentVersions)
          .where(
            and(
              eq(schema.agentVersions.profileId, fromPublicId('agent', shop.agentId)),
              eq(schema.agentVersions.state, 'published'),
            ),
          ),
    );
    expect(versions).toHaveLength(1);
  });

  it('grants the tools that only read, and never one that changes something', async () => {
    const tool = await shop.owner.post('/v1/admin/tools', {
      brandId: shop.brand.id,
      builtin: 'order_status',
    });
    expect(tool.status, JSON.stringify(tool.body)).toBe(201);
    const live = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/go-live`, {});
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    const config = live.body.published.config;
    expect(config.tools.grants).toEqual([{ toolId: tool.body.id, autopilot: true }]);
    expect(config.actions).toEqual({ handoff: true, choices: true, contact: true, search: true });
  });
});
