import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, signUp, startSlice, Visitor } from './slice-harness.js';

type Script =
  | { kind: 'answer'; label: string; confidence: number }
  | { kind: 'hang' }
  | { kind: 'error'; status: number };

/**
 * A fake Jev (TypeSafe systemOne) behind the real adapter: it answers the intent question as
 * scripted, fails, or never answers at all (ignoring cancellation, so only the adapter's own
 * deadline can end the call).
 */
function fakeJev() {
  const calls: Array<{ body: Record<string, any>; at: number }> = [];
  let script: Script = { kind: 'answer', label: 'other', confidence: 0.9 };
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    calls.push({ body, at: Date.now() });
    const current = script;
    if (current.kind === 'hang') return new Promise<Response>(() => undefined);
    if (current.kind === 'error') {
      return new Response(JSON.stringify({ error: { message: 'unavailable' } }), {
        status: current.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          intent: {
            type: 'choice',
            choice: current.label,
            confidence: current.confidence,
            probabilities: { [current.label]: current.confidence },
          },
        },
        usage: { input_tokens: 140, output_tokens: 4 },
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
  return {
    fetch,
    calls,
    set(next: Script) {
      script = next;
    },
  };
}

const jev = fakeJev();
let slice: Slice;
let alpha: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
const teams: Record<string, string> = {};

/** An inbox team, in the brand's workspace or tenant-wide, with its routing for the brand. */
async function routedTeam(
  name: string,
  routing: Record<string, unknown>,
  workspaceId: string | null = alpha.workspaceId,
): Promise<string> {
  const created = await alpha.owner.post('/v1/admin/teams', { name, workspaceId });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const set = await alpha.owner.put(
    `/v1/admin/brands/${alpha.brand.id}/routing/teams/${created.body.id}`,
    routing,
  );
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  return created.body.id as string;
}

const routingPath = () => `/v1/admin/brands/${alpha.brand.id}/decisions/team-routing`;

beforeAll(async () => {
  slice = await startSlice({ decisionFetch: jev.fetch });
  alpha = await connectedTenant(slice, 'routing');
  tenantId = fromPublicId('tenant', alpha.tenantId);
  // The inbox's teams: routing adds, per brand, their intents and languages.
  teams.Billing = await routedTeam('Billing', { intents: ['billing'], languages: ['en'] });
  teams['Billing Urdu'] = await routedTeam('Billing Urdu', {
    intents: ['billing'],
    languages: ['ur', 'roman-urdu'],
  });
  teams.Orders = await routedTeam('Orders', {
    intents: ['orders'],
    languages: ['en'],
    translationLanguages: ['ar'],
  });
  // A tenant-wide team may route for any brand.
  teams.Support = await routedTeam(
    'Support',
    { isDefault: true, languages: ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'] },
    null,
  );
  const threshold = { minConfidence: 0.6 };
  const draft = await alpha.owner.put(`${routingPath()}/draft`, {
    definition: {
      intents: [
        {
          key: 'billing',
          description: 'Payments, refunds and invoices',
          keywords: ['refund', 'payment', 'invoice', 'paise', 'ادائیگی'],
        },
        {
          key: 'orders',
          description: 'Delivery and order status',
          keywords: ['delivery', 'parcel', 'shipped', 'order status', 'طلبي'],
        },
      ],
      thresholds: {
        en: threshold,
        'roman-urdu': threshold,
        hinglish: threshold,
        ar: threshold,
        ur: threshold,
      },
    },
    provider: 'jev',
    modelVersion: 'jev-1.13.0',
    deadlineMs: 1500,
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const published = await alpha.owner.post(`${routingPath()}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  expect(published.body).toMatchObject({
    mode: 'shadow',
    published: { version: 1 },
    draft: null,
    // The slice's fake Jev transport counts as configured; the version Studio suggests.
    jev: { configured: true, recommendedModel: 'jev-1.13.0' },
  });
});

afterAll(async () => {
  await slice?.close();
});

beforeEach(() => {
  jev.calls.length = 0;
});

async function chat(firstMessage: string) {
  const visitor = new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    firstMessage,
    clientMessageId: randomUUID(),
  });
  expect(started.status).toBe(201);
  await slice.drain();
  return { visitor, conversationId: started.body.id as string };
}

async function recordsOf(conversationId: string) {
  const listed = await alpha.owner.get(`${routingPath()}/records?conversationId=${conversationId}`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.items as Array<Record<string, any>>;
}

/** The conversation's team in the inbox (its queue), as a public id; null when it has none. */
async function inboxTeamOf(conversationId: string): Promise<string | null> {
  const [state] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ teamId: schema.conversationInboxState.teamId })
      .from(schema.conversationInboxState)
      .where(
        eq(
          schema.conversationInboxState.conversationId,
          fromPublicId('conversation', conversationId),
        ),
      ),
  );
  return state?.teamId ? toPublicId('team', state.teamId) : null;
}

/** The Chatwoot team the inbox linked to a Hamnivo team on first use. */
async function chatwootTeamOf(teamPublicId: string): Promise<string | null> {
  const [link] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ externalTeamId: schema.teamAuthorityLinks.externalTeamId })
      .from(schema.teamAuthorityLinks)
      .where(
        and(
          eq(schema.teamAuthorityLinks.teamId, fromPublicId('team', teamPublicId)),
          eq(
            schema.teamAuthorityLinks.connectionId,
            fromPublicId('connection', alpha.connection.id),
          ),
        ),
      ),
  );
  return link ? String(link.externalTeamId) : null;
}

async function authorityState(conversationId: string) {
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
  return {
    control,
    state: await runtime.authority.getState(String(control.externalConversationId)),
  };
}

async function setMode(mode: 'off' | 'shadow' | 'live') {
  const response = await alpha.owner.put(`${routingPath()}/mode`, { mode });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.mode).toBe(mode);
}

describe('shadow routing (J02)', () => {
  it('records the provider and the baseline decisions and routes nothing', async () => {
    jev.set({ kind: 'answer', label: 'billing', confidence: 0.91 });
    const { conversationId } = await chat(
      'My payment failed and I need a refund. Write to ayesha@example.com',
    );
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      trigger: 'new_conversation',
      mode: 'shadow',
      provider: 'jev',
      modelVersion: 'jev-1.13.0',
      rubricVersion: 1,
      status: 'decided',
      providerIntent: 'billing',
      confidence: expect.closeTo(0.91, 5),
      baselineIntent: 'billing',
      finalIntent: 'billing',
      finalSource: 'provider',
      team: { id: teams.Billing, name: 'Billing' },
      language: 'en',
      languageMatch: 'native',
      explicitRequest: false,
      applied: false,
      inputTokens: 140,
      outputTokens: 4,
      offered: ['billing', 'orders', 'other'],
    });
    expect(record?.latencyMs).toEqual(expect.any(Number));
    expect(await inboxTeamOf(conversationId)).toBeNull();
    const { state } = await authorityState(conversationId);
    expect(state.teamRef).toBeNull();
    // Only the selected inputs went to Jev, with personal data replaced by its kind.
    expect(jev.calls).toHaveLength(1);
    const sent = JSON.stringify(jev.calls[0]?.body);
    expect(sent).not.toContain('ayesha@example.com');
    expect(sent).toContain('[email]');
    expect(jev.calls[0]?.body.questions.intent.criteria).toMatchObject({
      billing: 'Payments, refunds and invoices',
      orders: 'Delivery and order status',
    });
  });

  it('keeps the provider answer for audit when it falls below the threshold', async () => {
    jev.set({ kind: 'answer', label: 'orders', confidence: 0.4 });
    const { conversationId } = await chat('I need a refund for my payment');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      status: 'abstained',
      providerIntent: 'orders',
      confidence: expect.closeTo(0.4, 5),
      finalIntent: 'billing',
      finalSource: 'baseline',
      fallback: 'abstained',
      applied: false,
    });
    expect(record?.reason).toMatch(/below 0.6/);
  });
});

describe('live routing (J02, U07)', () => {
  beforeAll(async () => {
    await setMode('live');
  });

  it('applies the provider decision in the team’s inbox queue and in Chatwoot', async () => {
    jev.set({ kind: 'answer', label: 'orders', confidence: 0.88 });
    const { conversationId } = await chat('Has my parcel been shipped yet? I paid by card.');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      mode: 'live',
      status: 'decided',
      finalIntent: 'orders',
      finalSource: 'provider',
      team: { id: teams.Orders },
      applied: true,
    });
    // The inbox's path: the conversation is in the team's queue …
    expect(await inboxTeamOf(conversationId)).toBe(teams.Orders);
    const queue = await alpha.owner.get(
      `/v1/inbox/conversations?queue=all&status=all&teamId=${teams.Orders}`,
    );
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    expect((queue.body.items as Array<{ id: string }>).map((c) => c.id)).toContain(conversationId);
    // … and Chatwoot has the team the inbox created for it on first use.
    const { state } = await authorityState(conversationId);
    expect(state.teamRef).not.toBeNull();
    expect(state.teamRef).toBe(await chatwootTeamOf(teams.Orders as string));
    // Routing chose where the conversation waits, not who owns it.
    expect(state.owner).not.toMatchObject({ kind: 'user' });
    const audit = await alpha.owner.get('/v1/admin/audit?action=conversation.routed');
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  it('applies the baseline when the provider answer is below the threshold', async () => {
    jev.set({ kind: 'answer', label: 'orders', confidence: 0.3 });
    const { conversationId } = await chat('Please send my refund, the payment went through twice');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      status: 'abstained',
      finalIntent: 'billing',
      finalSource: 'baseline',
      team: { id: teams.Billing },
      applied: true,
    });
    expect(await inboxTeamOf(conversationId)).toBe(teams.Billing);
  });

  it('prefers the team that speaks the customer language', async () => {
    jev.set({ kind: 'answer', label: 'billing', confidence: 0.9 });
    const { conversationId } = await chat(
      'Mera refund abhi tak nahi mila, paise wapas kab milenge?',
    );
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      finalIntent: 'billing',
      language: expect.stringMatching(/^(hinglish|roman-urdu)$/),
      team: { id: teams['Billing Urdu'] },
      languageMatch: 'native',
      applied: true,
    });
    expect(await inboxTeamOf(conversationId)).toBe(teams['Billing Urdu']);
  });

  it('uses a reviewed translation path before a language gap', async () => {
    jev.set({ kind: 'answer', label: 'orders', confidence: 0.9 });
    const { conversationId } = await chat('أين طلبي؟ لم يصل بعد');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      language: 'ar',
      team: { id: teams.Orders },
      languageMatch: 'translation',
    });
  });

  it('falls back to the baseline within the deadline when Jev does not answer', async () => {
    jev.set({ kind: 'hang' });
    const visitor = new Visitor(slice.baseUrl, alpha.brand.widgetId, alpha.hostOrigin);
    await visitor.open();
    const started = await visitor.call('POST', '/v1/widget/conversations', {
      firstMessage: 'Where is my delivery? The parcel is late.',
      clientMessageId: randomUUID(),
    });
    const before = Date.now();
    await slice.drain();
    const conversationId = started.body.id as string;
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      status: 'unavailable',
      reason: 'deadline',
      retryable: true,
      providerIntent: null,
      confidence: null,
      finalIntent: 'orders',
      finalSource: 'baseline',
      fallback: 'unavailable',
      team: { id: teams.Orders },
      applied: true,
    });
    // The 1.5 s deadline holds even though this Jev ignores cancellation.
    expect(record?.latencyMs).toBeGreaterThanOrEqual(1400);
    expect(record?.latencyMs).toBeLessThan(2500);
    expect(Date.now() - before).toBeLessThan(15_000);
    // The customer was answered as usual: messaging never waits on Jev.
    const { control } = await authorityState(conversationId);
    expect(control.ownerMode).toBe('AI_ACTIVE');
  });

  it('opens the circuit after repeated failures and keeps routing on the baseline', async () => {
    jev.set({ kind: 'error', status: 503 });
    for (let i = 0; i < 5; i += 1) await chat('I have a question about my invoice payment');
    const callsBefore = jev.calls.length;
    const { conversationId } = await chat('Refund please, the payment failed');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      status: 'unavailable',
      reason: 'circuit_open',
      finalSource: 'baseline',
      finalIntent: 'billing',
      applied: true,
    });
    // An open circuit does not call Jev at all.
    expect(jev.calls.length).toBe(callsBefore);
  });
});

describe('the inbox team a person chose (H02)', () => {
  it('is never replaced by routing', async () => {
    jev.set({ kind: 'answer', label: 'orders', confidence: 0.9 });
    const { visitor, conversationId } = await chat('Where is my parcel? It has not arrived.');
    expect(await inboxTeamOf(conversationId)).toBe(teams.Orders);
    // A person moves the conversation to another team's queue, the inbox's way.
    const moved = await alpha.owner.post(`/v1/inbox/conversations/${conversationId}/team`, {
      teamId: teams.Billing,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    await slice.drain();
    expect(await inboxTeamOf(conversationId)).toBe(teams.Billing);
    // A handoff routes again, but the team a person chose stays.
    const sent = await visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'I want to talk to a person about my parcel' }],
    });
    expect(sent.status).toBe(202);
    await slice.drain();
    const records = await recordsOf(conversationId);
    expect(records[0]).toMatchObject({
      trigger: 'handoff',
      team: { id: teams.Orders },
      applied: false,
    });
    expect(await inboxTeamOf(conversationId)).toBe(teams.Billing);
  });
});

describe('teams and their routing (U07)', () => {
  it('lists the brand’s teams with their routing, and routes only for the team’s workspace', async () => {
    const plain = await alpha.owner.post('/v1/admin/teams', {
      name: 'Returns',
      workspaceId: alpha.workspaceId,
    });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    // A team of another workspace of the tenant.
    const [workspace] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .insert(schema.workspaces)
        .values({ tenantId, name: 'Wholesale', slug: `wholesale-${Date.now()}` })
        .returning(),
    );
    const foreign = await alpha.owner.post('/v1/admin/teams', {
      name: 'Wholesale desk',
      workspaceId: toPublicId('workspace', workspace?.id as string),
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);

    const listed = await alpha.owner.get(`/v1/admin/brands/${alpha.brand.id}/routing/teams`);
    expect(listed.status).toBe(200);
    const byName = new Map(
      (listed.body.items as Array<Record<string, any>>).map((t) => [t.name, t]),
    );
    expect(byName.get('Orders')).toMatchObject({
      id: teams.Orders,
      workspaceId: alpha.workspaceId,
      routing: { intents: ['orders'], translationLanguages: ['ar'], accepting: true },
    });
    expect(byName.get('Support')).toMatchObject({
      workspaceId: null,
      routing: { isDefault: true },
    });
    expect(byName.get('Returns')).toMatchObject({ id: plain.body.id, routing: null });
    expect(byName.has('Wholesale desk')).toBe(false);

    const refused = await alpha.owner.put(
      `/v1/admin/brands/${alpha.brand.id}/routing/teams/${foreign.body.id}`,
      { intents: ['billing'] },
    );
    expect(refused.status).toBe(422);
    const audit = await alpha.owner.get('/v1/admin/audit?action=team.routing_changed&limit=100');
    expect(audit.body.items.length).toBeGreaterThanOrEqual(4);
  });
});

describe('explicit requests for a person (J04 precedence 1)', () => {
  it('hands over before routing, and routing never takes it back', async () => {
    // Jev would say "other" with high confidence; it is only asked where to send the customer.
    jev.set({ kind: 'answer', label: 'other', confidence: 0.99 });
    const { conversationId } = await chat('I want to talk to a person about my refund');
    const { control } = await authorityState(conversationId);
    expect(control.ownerMode).toBe('WAITING_HUMAN');
    const records = await recordsOf(conversationId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ explicitRequest: true, applied: true });
    // The handoff happened first: its audit event precedes every call to Jev.
    const audit = await alpha.owner.get(
      '/v1/admin/audit?action=conversation.owner_changed&limit=100',
    );
    const handoff = (audit.body.items as Array<Record<string, any>>).find(
      (item) => item.target?.id === conversationId && item.data?.reason === 'customer_request',
    );
    expect(handoff).toBeDefined();
    for (const call of jev.calls) {
      expect(call.at).toBeGreaterThanOrEqual(Date.parse(handoff?.occurredAt));
    }
  });

  it('still hands over when Jev is down', async () => {
    jev.set({ kind: 'hang' });
    const { conversationId } = await chat('Mujhe kisi insaan se baat karni hai');
    const { control } = await authorityState(conversationId);
    expect(control.ownerMode).toBe('WAITING_HUMAN');
    const [record] = await recordsOf(conversationId);
    expect(record).toMatchObject({
      explicitRequest: true,
      finalSource: 'baseline',
      team: { id: teams.Support },
    });
  });
});

describe('rubric tests, reviews and experiments (J05, J07, J08)', () => {
  it('tests a message without routing anything and reports the explicit-request rule', async () => {
    jev.set({ kind: 'answer', label: 'billing', confidence: 0.8 });
    const tested = await alpha.owner.post(`${routingPath()}/test`, {
      rubric: 'published',
      message: 'I want a real person to help with this payment',
    });
    expect(tested.status, JSON.stringify(tested.body)).toBe(200);
    expect(tested.body).toMatchObject({
      record: {
        mode: 'test',
        trigger: 'test',
        status: 'decided',
        finalIntent: 'billing',
        applied: false,
      },
      policy: { explicitRequest: true, redacted: [] },
    });
  });

  it('keeps an invalid answer out of the decision and falls back', async () => {
    jev.set({ kind: 'answer', label: 'vip_refunds', confidence: 0.99 });
    const tested = await alpha.owner.post(`${routingPath()}/test`, {
      rubric: 'published',
      message: 'Where is my parcel?',
    });
    expect(tested.body.record).toMatchObject({
      status: 'invalid',
      providerIntent: null,
      confidence: null,
      finalIntent: 'orders',
      finalSource: 'baseline',
      fallback: 'invalid',
    });
  });

  it('records a reviewer correction next to the original advice', async () => {
    const listed = await alpha.owner.get(`${routingPath()}/records?status=decided&limit=50`);
    const decision = (listed.body.items as Array<Record<string, any>>).find(
      (item) => item.mode !== 'test',
    ) as Record<string, any>;
    const reviewed = await alpha.owner.post(`/v1/admin/decisions/${decision.id}/review`, {
      intent: 'orders',
      reason: 'The customer was asking about delivery.',
      trainingConsent: false,
    });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body).toMatchObject({
      finalIntent: decision.finalIntent,
      review: { intent: 'orders', trainingConsent: false },
    });
    const wrong = await alpha.owner.post(`/v1/admin/decisions/${decision.id}/review`, {
      intent: 'not_offered',
      reason: 'x',
    });
    expect(wrong.status).toBe(422);
  });

  it('compares the provider with the baseline over shadow and live records', async () => {
    const report = await alpha.owner.get(`${routingPath()}/experiment?days=7`);
    expect(report.status).toBe(200);
    const overall = report.body.overall;
    expect(overall.records).toBeGreaterThanOrEqual(10);
    expect(overall.unavailable).toBeGreaterThanOrEqual(2);
    expect(overall.decided + overall.abstained + overall.unavailable + overall.invalid).toBe(
      overall.records,
    );
    expect(overall.agreement).toEqual(expect.any(Number));
    expect(overall.reviewed).toBeGreaterThanOrEqual(1);
    expect(report.body.byLanguage.en.records).toBeGreaterThan(0);
  });
});

describe('access', () => {
  it('keeps routing records and teams inside their tenant', async () => {
    const other = await signUp(slice.gw, 'Other Owner', `other-${randomUUID()}@example.com`);
    const tenant = await other.post('/v1/tenants', {
      name: 'Other Store',
      slug: `other-${Date.now()}`,
    });
    other.tenant = tenant.body.tenant.id;
    const records = await other.get(`${routingPath()}/records`);
    expect(records.status).toBe(404);
    const team = await other.put(
      `/v1/admin/brands/${alpha.brand.id}/routing/teams/${teams.Billing}`,
      { accepting: false },
    );
    expect(team.status).toBe(404);
    const listed = await other.get(`/v1/admin/brands/${alpha.brand.id}/routing/teams`);
    expect(listed.status).toBe(404);
  });

  it('refuses live routing without a published rubric', async () => {
    const other = await connectedTenant(slice, `norubric${Date.now() % 10000}`);
    const response = await other.owner.put(
      `/v1/admin/brands/${other.brand.id}/decisions/team-routing/mode`,
      { mode: 'live' },
    );
    expect(response.status).toBe(422);
  });
});
