import { randomUUID } from 'node:crypto';
import { APICallError, type LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/** The mock model, with scripted replies or failures for the next calls. */
function scriptedModel() {
  const base = createMockModel();
  const script: Array<string | Error> = [];
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      const next = script.shift();
      if (next instanceof Error) throw next;
      const result = await base.doGenerate(call);
      return typeof next === 'string'
        ? { ...result, content: [{ type: 'text', text: next }] }
        : result;
    },
  };
  return { model, script };
}

const unavailable = () =>
  new APICallError({
    message: 'Service unavailable',
    url: 'https://models.example/v1',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });

const scripted = scriptedModel();
let slice: Slice;
let alpha: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;

beforeAll(async () => {
  slice = await startSlice({ model: scripted.model });
  alpha = await connectedTenant(slice, 'agents', { publishAgent: false });
  tenantId = fromPublicId('tenant', alpha.tenantId);
});

afterAll(async () => {
  await slice?.close();
});

async function chat(firstMessage: string) {
  const visitor = new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage,
    clientMessageId: randomUUID(),
  });
  if (started.status !== 201) throw new Error(`start: ${started.status}`);
  await slice.drain();
  return { visitor, conversationId: started.body.id as string };
}

async function say(visitor: Visitor, conversationId: string, text: string) {
  const sent = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    parts: [{ type: 'text', text }],
  });
  expect(sent.status).toBe(202);
  await slice.drain();
}

/** Control row and Chatwoot's messages (staff view, so notes are visible too). */
async function inspect(conversationId: string) {
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  if (!control) throw new Error('control missing');
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', alpha.connection.id));
  const messages = await runtime.authority.listMessages(String(control.externalConversationId), {
    view: 'staff',
  });
  return {
    control,
    botReplies: messages.filter((m) => m.sender.kind === 'bot' && !m.private).map((m) => m.text),
    notes: messages.filter((m) => m.private).map((m) => m.text ?? ''),
  };
}

async function runsOf(conversationId: string) {
  const listed = await alpha.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
  expect(listed.status).toBe(200);
  return listed.body.items as Array<Record<string, any>>;
}

async function publish(version?: number) {
  const published = await alpha.owner.post(
    `/v1/admin/agents/${alpha.agentId}/publish`,
    version ? { version } : {},
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body;
}

describe('the default agent', () => {
  it('is created as an unpublished draft, and people answer until it is published', async () => {
    const listed = await alpha.owner.get('/v1/admin/agents');
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        id: alpha.agentId,
        brandId: alpha.brand.id,
        isDefault: true,
        publishedVersion: null,
        draftVersion: 1,
      }),
    ]);
    const { conversationId } = await chat('Assalamu alaikum, is my order shipped?');
    const seen = await inspect(conversationId);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.botReplies).toEqual([]);
    expect(seen.notes.some((n) => n.includes('No AI agent is published'))).toBe(true);
  });

  it('answers once published, and the run records version, model and tokens but no text', async () => {
    const detail = await publish();
    expect(detail.published).toMatchObject({ version: 1, state: 'published' });
    expect(detail.published.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.draft).toBeNull();

    const secret = `order ${randomUUID()}`;
    const { conversationId } = await chat(`Where is my ${secret}?`);
    const seen = await inspect(conversationId);
    expect(seen.control.ownerMode).toBe('AI_ACTIVE');
    expect(seen.botReplies).toHaveLength(1);

    const [run] = await runsOf(conversationId);
    expect(run).toMatchObject({
      agentId: alpha.agentId,
      agentVersion: 1,
      kind: 'reply',
      state: 'succeeded',
      outcome: 'replied',
      provider: 'mock',
      modelId: 'hamnivo-mock',
    });
    expect(run?.inputTokens).toBeGreaterThan(0);
    const full = await alpha.owner.get(`/v1/admin/runs/${run?.id}`);
    expect(
      full.body.steps.map((s: { kind: string; status: string }) => [s.kind, s.status]),
    ).toEqual([
      ['model', 'ok'],
      ['guard', 'ok'],
    ]);
    // Telemetry holds hashes and counts; neither the question nor the reply is stored in it.
    const stored = JSON.stringify(
      await withTenant(slice.app, { tenantId }, async (tx) => [
        await tx.select().from(schema.runs),
        await tx.select().from(schema.runSteps),
      ]),
    );
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(seen.botReplies[0]);
    const usage = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.usageEntries).where(eq(schema.usageEntries.sourceRef, run?.id)),
    );
    // Tokens, and the reply itself, which counts against the plan's AI replies (A08).
    expect(usage.map((u) => u.meter).sort()).toEqual([
      'ai.replies',
      'ai.tokens.input',
      'ai.tokens.output',
    ]);
  });
});

describe('versions', () => {
  it('never change once published; edits make a draft and rollback restores an earlier one', async () => {
    const base = (await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`)).body.published.config;
    const draft = await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: { ...base, displayName: 'Helper v2', tone: 'formal' },
    });
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ version: 2, state: 'draft' });

    // Saving over a draft you did not see is a conflict.
    const stale = await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: { ...base, displayName: 'Stale edit' },
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');

    expect((await publish()).published).toMatchObject({ version: 2 });
    const rolledBack = await publish(1);
    expect(rolledBack.published).toMatchObject({ version: 1, state: 'published' });
    const versions = await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}/versions`);
    expect(
      versions.body.items.map((v: { version: number; state: string }) => [v.version, v.state]),
    ).toEqual([
      [2, 'retired'],
      [1, 'published'],
    ]);
    const first = versions.body.items.find((v: { version: number }) => v.version === 1);
    expect(first.config.displayName).toBe(base.displayName);
    expect(first.configHash).toBe(rolledBack.published.configHash);
  });

  it('refuses to publish a model it has no credentials for', async () => {
    const base = (await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`)).body.published.config;
    await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: { ...base, model: { provider: 'anthropic', modelId: 'claude-sonnet-5' } },
    });
    const refused = await alpha.owner.post(`/v1/admin/agents/${alpha.agentId}/publish`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toContain('No anthropic key');
  });
});

describe('model connections', () => {
  it('store the key encrypted, show only a hint, and check the allowed models', async () => {
    const created = await alpha.owner.post('/v1/admin/model-connections', {
      provider: 'openai',
      label: 'Team key',
      apiKey: 'sk-test-0123456789abcd',
      allowedModels: ['gpt-5-mini'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ provider: 'openai', keyHint: 'abcd', status: 'active' });
    expect(JSON.stringify(created.body)).not.toContain('0123456789');
    const [secret] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.secrets).where(eq(schema.secrets.kind, 'model_api_key')),
    );
    expect(secret?.ciphertext.toString('utf8')).not.toContain('sk-test');

    const base = (await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`)).body.published.config;
    await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: {
        ...base,
        model: { provider: 'openai', modelId: 'gpt-4o', connectionId: created.body.id },
      },
    });
    const refused = await alpha.owner.post(`/v1/admin/agents/${alpha.agentId}/publish`, {});
    expect(refused.status).toBe(422);
    expect(refused.body.detail).toContain('not allowed');

    // With an allowed model, a real provider publishes: the key stays sealed until a reply runs.
    await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: {
        ...base,
        model: { provider: 'openai', modelId: 'gpt-5-mini', connectionId: created.body.id },
      },
    });
    const published = await alpha.owner.post(`/v1/admin/agents/${alpha.agentId}/publish`, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.published.config.model).toMatchObject({ provider: 'openai' });

    const disabled = await alpha.owner.post(
      `/v1/admin/model-connections/${created.body.id}/disable`,
    );
    expect(disabled.body.status).toBe('disabled');
    const [revoked] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.secrets).where(eq(schema.secrets.kind, 'model_api_key')),
    );
    expect(revoked?.revokedAt).not.toBeNull();
  });
});

describe('kill switches', () => {
  it('stop AI replies and hand conversations to people; clearing lets the AI answer again', async () => {
    const { visitor, conversationId } = await chat('Salaam, I need help');
    expect((await inspect(conversationId)).botReplies).toHaveLength(1);

    const stop = await alpha.owner.post('/v1/admin/kill-switches', {
      scope: 'brand',
      targetId: alpha.brand.id,
      reason: 'Incident: wrong prices in answers',
    });
    expect(stop.status).toBe(201);
    expect(stop.body).toMatchObject({ scope: 'brand', targetId: alpha.brand.id, active: true });

    // The conversation the AI held goes to people on the customer's next message.
    await say(visitor, conversationId, 'Are you still there?');
    const held = await inspect(conversationId);
    expect(held.control.ownerMode).toBe('WAITING_HUMAN');
    expect(held.botReplies).toHaveLength(1);
    expect(held.notes.some((n) => n.includes('kill switch'))).toBe(true);
    expect((await runsOf(conversationId))[0]).toMatchObject({ outcome: 'handoff' });

    // New conversations start with people while the switch is on.
    const during = await chat('Hello?');
    expect((await inspect(during.conversationId)).control.ownerMode).toBe('WAITING_HUMAN');

    const cleared = await alpha.owner.post(`/v1/admin/kill-switches/${stop.body.id}/clear`);
    expect(cleared.body.active).toBe(false);
    const after = await chat('Hello again');
    expect((await inspect(after.conversationId)).botReplies).toHaveLength(1);
  });
});

describe('asking for a person', () => {
  it('hands over at once when the customer types it, in Roman Urdu too', async () => {
    const { conversationId } = await chat('Mujhe kisi insaan se baat karni hai please');
    const seen = await inspect(conversationId);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.botReplies).toEqual([]);
    expect(seen.notes.some((n) => n.includes('asked to talk to a person'))).toBe(true);
    const [run] = await runsOf(conversationId);
    expect(run).toMatchObject({ outcome: 'handoff' });
  });

  it('keeps answering when the customer says they do not want a person', async () => {
    const { conversationId } = await chat('Insaan nahi chahiye, bas order ka status batao');
    const seen = await inspect(conversationId);
    expect(seen.control.ownerMode).toBe('AI_ACTIVE');
    expect(seen.botReplies).toHaveLength(1);
  });
});

describe('honest identity', () => {
  it('never publishes a reply that claims to be human', async () => {
    scripted.script.push('I am a real human, not a bot.', 'Main insaan hoon, bot nahi.');
    const { conversationId } = await chat('Are you a person?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual([]);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.notes.some((n) => n.includes('honesty rules'))).toBe(true);
    const [run] = await runsOf(conversationId);
    expect(run).toMatchObject({ outcome: 'blocked' });
    const full = await alpha.owner.get(`/v1/admin/runs/${run?.id}`);
    const guards = full.body.steps.filter((s: { kind: string }) => s.kind === 'guard');
    expect(guards.map((g: { detail: { rule?: string } }) => g.detail.rule)).toEqual([
      'en.claims_human',
      'latn.claims_human',
    ]);
  });

  it('asks the model once more and publishes an honest answer', async () => {
    scripted.script.push('Yes, I am a person.', 'I am an AI assistant, and I can help you.');
    const { conversationId } = await chat('Is this a real person?');
    expect((await inspect(conversationId)).botReplies).toEqual([
      'I am an AI assistant, and I can help you.',
    ]);
  });
});

describe('model failures', () => {
  it('fall back to the next model when the first is unavailable', async () => {
    const base = (await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`)).body.published.config;
    await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: {
        ...base,
        model: { provider: 'mock', modelId: 'hamnivo-mock' },
        fallbackModels: [{ provider: 'mock', modelId: 'hamnivo-mock-backup' }],
      },
    });
    await publish();
    // The provider explicitly reports zero usage: a known failed attempt can fall back.
    scripted.script.push(
      Object.assign(unavailable(), { usage: { inputTokens: 0, outputTokens: 0 } }),
    );
    const { conversationId } = await chat('Do you ship to Lahore?');
    expect((await inspect(conversationId)).botReplies).toHaveLength(1);
    const [run] = await runsOf(conversationId);
    expect(run).toMatchObject({ outcome: 'replied', modelId: 'hamnivo-mock-backup' });
  });

  it('do not blindly retry an unknown provider outcome and hand over with an honest note', async () => {
    scripted.script.push(...Array.from({ length: 6 }, unavailable));
    const { conversationId } = await chat('Can I change my address?');
    // The outbox retries with backoff; make the pending retries due instead of waiting.
    for (let i = 0; i < 3; i += 1) {
      await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .update(schema.outboxEvents)
          .set({ availableAt: new Date(Date.now() - 1000) })
          .where(isNull(schema.outboxEvents.processedAt)),
      );
      await slice.drain();
    }
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual([]);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.notes.some((n) => n.includes('model was unavailable'))).toBe(true);
    const [run] = await runsOf(conversationId);
    expect(run).toMatchObject({
      outcome: 'handoff',
      state: 'failed',
      errorKind: 'usage_unresolved',
    });
    expect(scripted.script).toHaveLength(5);
    scripted.script.length = 0;
  });
});

describe('assist mode', () => {
  it('writes drafts for people to review and never answers customers', async () => {
    const base = (await alpha.owner.get(`/v1/admin/agents/${alpha.agentId}`)).body.published.config;
    await alpha.owner.put(`/v1/admin/agents/${alpha.agentId}/draft`, {
      config: { ...base, mode: 'assist' },
    });
    await publish();
    const { conversationId } = await chat('What are your opening hours?');
    const seen = await inspect(conversationId);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.botReplies).toEqual([]);
    // The draft waits in Studio (HNV-09-05); nothing reaches Chatwoot, not even a note.
    expect(seen.notes.some((n) => n.includes('AI suggestion'))).toBe(false);
    const drafts = await alpha.owner.get(`/v1/inbox/conversations/${conversationId}/ai-drafts`);
    expect(drafts.status, JSON.stringify(drafts.body)).toBe(200);
    expect(drafts.body.pending).toMatchObject({ state: 'pending' });
    const runs = await runsOf(conversationId);
    expect(runs[0]).toMatchObject({ kind: 'draft', outcome: 'drafted' });
  });
});

describe('tenant isolation', () => {
  it('keeps agents, runs and kill switches inside their tenant', async () => {
    const beta = await connectedTenant(slice, 'agents-beta');
    const agent = await beta.owner.get(`/v1/admin/agents/${alpha.agentId}`);
    expect(agent.status).toBe(404);
    const runs = await beta.owner.get('/v1/admin/runs');
    const alphaRuns = await runsOf((await chat('Isolation check')).conversationId);
    expect(runs.body.items.map((r: { id: string }) => r.id)).not.toContain(alphaRuns[0]?.id);
    const switches = await beta.owner.get('/v1/admin/kill-switches');
    expect(switches.body.items).toEqual([]);
    const active = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.killSwitches)
        .where(and(eq(schema.killSwitches.scope, 'brand'), isNull(schema.killSwitches.clearedAt))),
    );
    expect(active).toEqual([]);
  });
});
