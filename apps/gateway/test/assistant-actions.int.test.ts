import { randomUUID } from 'node:crypto';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * The assistant acts while it answers (AgentConfig.actions): it offers answers to tap, notes the
 * contact details a customer gives for the team, and passes a conversation to people with a
 * summary. Each happens only once its reply is posted. A stand-in model calls the action a test
 * names, once per question.
 */
type Shop = Awaited<ReturnType<typeof connectedTenant>>;
const plans = new Map<string, { toolName: string; input: Record<string, unknown> }>();
const planned = new Set<string>();
/** The instructions the model got for each question. */
const systems = new Map<string, string>();
const model = createMockModel({
  reply: () => 'Here is what I can do for you.',
  tools: {
    plan: ({ turn }) => {
      systems.set(turn.text, turn.system);
      const plan = plans.get(turn.text);
      if (!plan || planned.has(turn.text)) return null;
      planned.add(turn.text);
      return plan;
    },
  },
});

let slice: Slice;
let shop: Shop;

beforeAll(async () => {
  slice = await startSlice({ model });
  shop = await connectedTenant(slice, 'actions');
  const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
  const draft = await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
    config: {
      ...detail.body.published.config,
      actions: { handoff: true, choices: true, contact: true, search: false },
    },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(200);
  const published = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
});

afterAll(async () => {
  await slice?.close();
});

async function ask(
  text: string,
  plan: { toolName: string; input: Record<string, unknown> } | null,
  context?: { url: string; title: string },
) {
  if (plan) plans.set(text, plan);
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: text,
    ...(context ? { context } : {}),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await slice.drain();
  const id = started.body.id as string;
  const history = await visitor.call('GET', `/v1/widget/conversations/${id}/messages`);
  const tenantId = fromPublicId('tenant', shop.tenantId);
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', id))),
  );
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(tenantId, fromPublicId('connection', shop.connection.id));
  const staff = await runtime.authority.listMessages(String(control?.externalConversationId), {
    view: 'staff',
  });
  return {
    control,
    replies: (history.body.items as Array<Record<string, any>>).filter(
      (m) => m.sender.kind === 'ai_agent',
    ),
    notes: staff.filter((m) => m.private).map((m) => m.text ?? ''),
  };
}

describe('the assistant acting while it answers', () => {
  it('offers answers to tap under its reply', async () => {
    const seen = await ask('Which plan suits a small shop?', {
      toolName: 'offer_choices',
      input: { prompt: 'Which plan?', options: ['Basic', 'Pro', 'Pro', 'Business'] },
    });
    expect(seen.replies).toHaveLength(1);
    const card = seen.replies[0]?.parts.find((p: { type: string }) => p.type === 'card');
    expect(card?.card).toEqual({
      kind: 'choices',
      version: 1,
      prompt: 'Which plan?',
      options: [
        { value: 'Basic', label: 'Basic' },
        { value: 'Pro', label: 'Pro' },
        { value: 'Business', label: 'Business' },
      ],
      allowFreeText: true,
    });
    expect(seen.control?.ownerMode).toBe('AI_ACTIVE');
  });

  it('notes the contact details a customer gives, for the team, and never a bad address', async () => {
    const seen = await ask('Reach me later please, I am Sara', {
      toolName: 'save_contact',
      input: { name: 'Sara Noor', email: 'not-an-address', phone: '+92 300 1234567' },
    });
    expect(seen.replies).toHaveLength(1);
    const note = seen.notes.find((n) => n.startsWith('The customer gave contact details'));
    expect(note).toContain('Name: Sara Noor');
    expect(note).toContain('Phone: +92 300 1234567');
    expect(note).not.toContain('not-an-address');
  });

  it('passes the conversation to people after its reply, with its summary', async () => {
    const seen = await ask('My parcel came broken, what now?', {
      toolName: 'handoff_to_person',
      input: { summary: 'Parcel arrived broken; wants a replacement.' },
    });
    // The reply went out first; then people have it, and know why.
    expect(seen.replies).toHaveLength(1);
    expect(seen.control?.ownerMode).not.toBe('AI_ACTIVE');
    expect(seen.control?.ownerReason).toBe('ai_escalated');
    expect(seen.notes.join('\n')).toContain('Parcel arrived broken; wants a replacement.');
  });

  it('knows which page of the website the customer is on', async () => {
    const text = 'Is this plan good for two shops?';
    await ask(text, null, { url: 'https://actions.example/plans/pro', title: 'Pro plan' });
    expect(systems.get(text)).toContain(
      '<page url="https://actions.example/plans/pro">Pro plan</page>',
    );
    // And the actions it may use, in its instructions.
    expect(systems.get(text)).toContain('handoff_to_person');
  });
});
