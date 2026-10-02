import { randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/** The mock model with scripted replies for the next calls; it keeps every system prompt. */
function scriptedModel() {
  const base = createMockModel();
  const script: string[] = [];
  const prompts: string[] = [];
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      prompts.push(JSON.stringify(call.prompt));
      const next = script.shift();
      const result = await base.doGenerate(call);
      return next ? { ...result, content: [{ type: 'text', text: next }] } : result;
    },
  };
  return { model, script, prompts };
}

type FakeAnswer =
  | { type: 'choice'; choice: string; confidence: number }
  | { type: 'noul'; noul: number };

/**
 * A fake Jev (TypeSafe systemOne) behind the real adapter. `answer` decides each question from
 * the request body; `mode` makes it fail or never answer (ignoring cancellation, so only the
 * adapter's deadline ends the call).
 */
function fakeJev() {
  const calls: Array<{ body: Record<string, any>; at: number }> = [];
  const state: {
    mode: 'answer' | 'hang' | 'error';
    answer: (question: string, body: Record<string, any>) => FakeAnswer;
  } = {
    mode: 'answer',
    answer: () => ({ type: 'choice', choice: 'supports', confidence: 0.95 }),
  };
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ body, at: Date.now() });
    if (state.mode === 'hang') return new Promise<Response>(() => undefined);
    if (state.mode === 'error') {
      return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    const answers = Object.fromEntries(
      Object.keys(body.questions as Record<string, unknown>).map((question) => {
        const a = state.answer(question, body);
        return [
          question,
          a.type === 'choice'
            ? {
                type: 'choice',
                choice: a.choice,
                confidence: a.confidence,
                probabilities: { [a.choice]: a.confidence },
              }
            : { type: 'noul', noul: a.noul },
        ];
      }),
    );
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers,
        usage: { input_tokens: 320, output_tokens: 6 },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-typesafe-request-id': `req_${calls.length}`,
        },
      },
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls, state };
}

const scripted = scriptedModel();
const jev = fakeJev();
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;

const checksPath = () => `/v1/admin/brands/${shop.brand.id}/checks`;

/** Jev's relation answer per claim: claims containing a key get its label. */
function relations(byPhrase: Record<string, [string, number]>) {
  jev.state.mode = 'answer';
  jev.state.answer = (question, body) => {
    const claim = String(body.state?.[`claim_${/^c(\d+)_/.exec(question)?.[1]}`] ?? '');
    const hit = Object.entries(byPhrase).find(([phrase]) => claim.includes(phrase));
    const [choice, confidence] = hit?.[1] ?? ['supports', 0.95];
    return { type: 'choice', choice, confidence };
  };
}

async function setMode(mode: 'off' | 'shadow' | 'live') {
  const set = await shop.owner.put(`${checksPath()}/answer-check/mode`, { mode });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  expect(set.body.mode).toBe(mode);
}

async function chat(firstMessage: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage,
    clientMessageId: randomUUID(),
  });
  expect(started.status).toBe(201);
  await slice.drain();
  return { visitor, conversationId: started.body.id as string };
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
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  const messages = await runtime.authority.listMessages(String(control.externalConversationId), {
    view: 'staff',
  });
  return {
    control,
    botReplies: messages.filter((m) => m.sender.kind === 'bot' && !m.private).map((m) => m.text),
    notes: messages.filter((m) => m.private).map((m) => m.text ?? ''),
  };
}

async function checksOf(conversationId: string) {
  const listed = await shop.owner.get(
    `${checksPath()}/answer-check/records?conversationId=${conversationId}`,
  );
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  // Oldest first, as they happened.
  return (listed.body.items as Array<Record<string, any>>).reverse();
}

beforeAll(async () => {
  slice = await startSlice({ model: scripted.model, decisionFetch: jev.fetch });
  shop = await connectedTenant(slice, 'checks');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const source = await shop.owner.post('/v1/admin/knowledge/sources', {
    brandId: shop.brand.id,
    name: 'Help centre',
  });
  expect(source.status).toBe(201);
  const added = await shop.owner.post(`/v1/admin/knowledge/sources/${source.body.id}/documents`, {
    title: 'Returns policy',
    content: {
      mediaType: 'text/markdown',
      text: '# Returns\n\nYou can return unworn items within 30 days of delivery.',
    },
  });
  expect(added.status).toBe(202);
  const urdu = await shop.owner.post(`/v1/admin/knowledge/sources/${source.body.id}/documents`, {
    title: 'واپسی',
    content: { mediaType: 'text/plain', text: 'آپ تیس دن میں سامان واپس کر سکتے ہیں۔' },
  });
  expect(urdu.status).toBe(202);
  await slice.drain();
  const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
  await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
    config: { ...detail.body.published.config, knowledgeSourceIds: [source.body.id] },
  });
  const published = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
  expect(published.status).toBe(200);
});

afterAll(async () => {
  await slice?.close();
});

beforeEach(() => {
  jev.calls.length = 0;
  scripted.prompts.length = 0;
});

describe('checks in Studio', () => {
  it('lists the answer check in shadow mode, with the question Jev is asked', async () => {
    const listed = await shop.owner.get(checksPath());
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({
        task: 'answer-check',
        mode: 'shadow',
        published: null,
        draft: null,
        questions: [
          expect.objectContaining({
            key: 'relation',
            type: 'choice',
            instructions: 'How does passage_1 relate to claim_1?',
          }),
        ],
        jev: expect.objectContaining({ configured: true, recommendedModel: 'jev-1.13.0' }),
      }),
    ]);
  });

  it('refuses thresholds for questions the check does not ask, and live mode before publishing', async () => {
    const wrongKey = await shop.owner.put(`${checksPath()}/answer-check/draft`, {
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      thresholds: { en: { intent: { type: 'choice', minConfidence: 0.8 } } },
    });
    expect(wrongKey.status).toBe(422);
    const wrongType = await shop.owner.put(`${checksPath()}/answer-check/draft`, {
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      thresholds: { en: { relation: { type: 'noul', trueAtLeast: 0.8, falseAtMost: 0.2 } } },
    });
    expect(wrongType.status).toBe(422);
    const unpinned = await shop.owner.put(`${checksPath()}/answer-check/draft`, {
      provider: 'jev',
      modelVersion: 'jev-latest',
    });
    expect(unpinned.status).toBe(422);
    const live = await shop.owner.put(`${checksPath()}/answer-check/mode`, { mode: 'live' });
    expect(live.status).toBe(422);
    const unknown = await shop.owner.get(`${checksPath()}/no-such-check/records`);
    expect(unknown.status).toBe(404);
  });

  it('saves and publishes a versioned rubric, audited', async () => {
    const draft = await shop.owner.put(`${checksPath()}/answer-check/draft`, {
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      deadlineMs: 1500,
      thresholds: { en: { relation: { type: 'choice', minConfidence: 0.8 } } },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    expect(draft.body).toMatchObject({ version: 1, state: 'draft', provider: 'jev' });
    const published = await shop.owner.post(`${checksPath()}/answer-check/publish`, {});
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body).toMatchObject({
      mode: 'shadow',
      published: {
        version: 1,
        thresholds: { en: { relation: { type: 'choice', minConfidence: 0.8 } } },
      },
      draft: null,
    });
    const audit = await shop.owner.get('/v1/admin/audit?action=decision.rubric.published');
    expect(
      (audit.body.items as Array<Record<string, any>>).some(
        (item) => item.data?.task === 'answer-check',
      ),
    ).toBe(true);
  });
});

describe('shadow mode', () => {
  it('records a sentence the passage does not support, and publishes the reply as today', async () => {
    relations({ '90 days': ['contradicts', 0.97] });
    scripted.script.push('Hello! You can return items within 90 days [1].');
    const { conversationId } = await chat('How long do I have to return shoes?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['Hello! You can return items within 90 days [1].']);
    expect(jev.calls).toHaveLength(1);
    // Only the claim and the passage it cites go to Jev, in one call.
    expect(jev.calls[0]?.body.state).toEqual({
      claim_1: 'You can return items within 90 days.',
      passage_1: expect.stringContaining('within 30 days of delivery'),
    });
    expect(Object.keys(jev.calls[0]?.body.questions)).toEqual(['c1_p1']);
    const [check] = await checksOf(conversationId);
    expect(check).toMatchObject({
      mode: 'shadow',
      status: 'decided',
      verdict: 'fail',
      action: 'regenerate',
      applied: false,
      language: 'en',
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      rubricVersion: 1,
      inputTokens: 320,
      answers: { c1_p1: { label: 'contradicts', confidence: 0.97, kept: true } },
      detail: expect.objectContaining({
        claims: [{ sentence: 1, documents: [expect.stringMatching(/^doc_/)] }],
        verdicts: [{ sentence: 1, verdict: 'unsupported' }],
      }),
    });
    // Labels and numbers only: neither the reply nor the passage is stored with the check.
    expect(JSON.stringify(check)).not.toContain('90 days');
    expect(JSON.stringify(check)).not.toContain('30 days');
    const runs = await shop.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
    const run = await shop.owner.get(`/v1/admin/runs/${runs.body.items[0].id}`);
    expect(run.body.steps).toContainEqual(
      expect.objectContaining({
        kind: 'guard',
        name: 'answer_check',
        status: 'ok',
        provider: 'jev',
        inputTokens: 320,
        detail: expect.objectContaining({ mode: 'shadow', verdict: 'fail' }),
      }),
    );
  });

  it('sends Jev the cited sentence with personal data replaced by its kind', async () => {
    relations({});
    scripted.script.push('We will write to sara@example.com: returns take 30 days [1].');
    await chat('Can I return it? My email is sara@example.com');
    const claim = String(jev.calls[0]?.body.state.claim_1);
    expect(claim).toContain('We will write to [email]');
    expect(claim).toContain('returns take 30 days.');
    expect(JSON.stringify(jev.calls[0]?.body)).not.toContain('sara@example.com');
  });

  it('asks nothing when the reply cites nothing', async () => {
    scripted.script.push('I can help with that. What is your order number?');
    const { conversationId } = await chat('Can you help me?');
    expect(jev.calls).toHaveLength(0);
    expect(await checksOf(conversationId)).toEqual([]);
  });
});

describe('live mode', () => {
  beforeAll(async () => {
    await setMode('live');
  });

  it('publishes a reply whose cited sentences are supported', async () => {
    relations({});
    scripted.script.push('You can return unworn items within 30 days [1].');
    const { conversationId } = await chat('Can I return shoes?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['You can return unworn items within 30 days [1].']);
    expect(await checksOf(conversationId)).toEqual([
      expect.objectContaining({ verdict: 'pass', action: 'publish', applied: true }),
    ]);
  });

  it('never publishes an unsupported claim: the reply is written again without it', async () => {
    relations({ '90 days': ['contradicts', 0.97] });
    scripted.script.push(
      'Returns are accepted within 90 days [1].',
      'You can return unworn items within 30 days [1].',
    );
    const { conversationId } = await chat('What is the return window?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['You can return unworn items within 30 days [1].']);
    expect(seen.botReplies.join(' ')).not.toContain('90 days');
    // The model was told which sentence to leave out.
    expect(scripted.prompts.at(-1)).toContain('Returns are accepted within 90 days.');
    expect(await checksOf(conversationId)).toEqual([
      expect.objectContaining({ verdict: 'fail', action: 'regenerate', applied: true }),
      expect.objectContaining({ verdict: 'pass', action: 'publish', applied: true }),
    ]);
  });

  it('hands over with a note when the second draft is not supported either', async () => {
    relations({ days: ['says_nothing', 0.93] });
    scripted.script.push(
      'Returns are accepted within 90 days [1].',
      'Returns are free for 60 days [1].',
    );
    const { conversationId } = await chat('How many days do I have?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual([]);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(seen.notes.some((n) => n.includes('did not support it'))).toBe(true);
    expect(await checksOf(conversationId)).toEqual([
      expect.objectContaining({ verdict: 'fail', action: 'regenerate', applied: true }),
      expect.objectContaining({ verdict: 'fail', action: 'handoff', applied: true }),
    ]);
  });

  it('does not let an answer below its threshold stand: it is written again', async () => {
    relations({ 'free returns': ['supports', 0.55] });
    scripted.script.push(
      'We offer free returns [1].',
      'You can return unworn items within 30 days [1].',
    );
    const { conversationId } = await chat('Are returns free?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['You can return unworn items within 30 days [1].']);
    const [first] = await checksOf(conversationId);
    expect(first).toMatchObject({
      verdict: 'unsure',
      action: 'regenerate',
      answers: { c1_p1: { label: 'supports', confidence: 0.55, kept: false } },
    });
  });

  it('behaves as today for a language that was not evaluated, and records it', async () => {
    relations({ '۹۰': ['contradicts', 0.97] });
    scripted.script.push('آپ ۹۰ دن میں سامان واپس کر سکتے ہیں [1]۔');
    const { conversationId } = await chat('میں سامان کتنے دن میں واپس کر سکتا ہوں؟');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['آپ ۹۰ دن میں سامان واپس کر سکتے ہیں [1]۔']);
    expect(await checksOf(conversationId)).toEqual([
      expect.objectContaining({
        status: 'abstained',
        verdict: 'abstained',
        action: 'publish',
        applied: false,
        language: 'ur',
        reason: 'not evaluated for this language (ur)',
      }),
    ]);
  });

  it('behaves as today when Jev is unavailable, within the deadline, and records it', async () => {
    jev.state.mode = 'hang';
    scripted.script.push('Returns are accepted within 90 days [1].');
    const started = Date.now();
    const { conversationId } = await chat('Can I still return my order?');
    const seen = await inspect(conversationId);
    expect(seen.botReplies).toEqual(['Returns are accepted within 90 days [1].']);
    const [check] = await checksOf(conversationId);
    expect(check).toMatchObject({
      status: 'unavailable',
      reason: 'deadline',
      verdict: 'unavailable',
      action: 'publish',
      applied: false,
    });
    expect(check?.latencyMs).toBeLessThan(2500);
    expect(Date.now() - started).toBeLessThan(20_000);
    jev.state.mode = 'answer';
  });
});

describe('access', () => {
  it('keeps checks and their records inside the tenant', async () => {
    const other = await connectedTenant(slice, 'checks-other');
    const listed = await other.owner.get(checksPath());
    expect(listed.status).toBe(404);
    const records = await other.owner.get(`${checksPath()}/answer-check/records`);
    expect(records.status).toBe(404);
    const mode = await other.owner.put(`${checksPath()}/answer-check/mode`, { mode: 'off' });
    expect(mode.status).toBe(404);
  });
});
