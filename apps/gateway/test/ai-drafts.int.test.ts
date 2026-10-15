import { createHash, randomUUID } from 'node:crypto';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from './harness.js';
import { audits, authority, customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, type Visitor } from './slice-harness.js';

/**
 * AI drafts awaiting review (HNV-09-05, G03): an assist-mode agent writes a reply to each customer
 * message from public knowledge only; a person approves it (as written or edited) or rejects it,
 * and it goes stale when the conversation moves on. Nothing reaches Chatwoot until a person sends.
 */

/** The mock model, answering with `answer` when set, and keeping every prompt it was given. */
function answeringModel() {
  const base = createMockModel();
  const state: { answer: string | null; prompts: string[] } = { answer: null, prompts: [] };
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      state.prompts.push(JSON.stringify(call.prompt));
      const result = await base.doGenerate(call);
      return state.answer ? { ...result, content: [{ type: 'text', text: state.answer }] } : result;
    },
  };
  return { model, state };
}

const answering = answeringModel();
let slice: Slice;
let shop: Shop;
let other: Shop;
let tenantId: string;
let amina: { client: Client; staffId: string };
let rayan: { client: Client; staffId: string };
let ana: { client: Client; staffId: string };

const inbox = (id: string, rest = '') => `/v1/inbox/conversations/${id}${rest}`;
const PUBLIC_TEXT = 'You can change the delivery address before the order is dispatched.';
const INTERNAL_TEXT = 'Delivery address changes cost the courier 3 USD under our contract.';

/** A customer writes; the assist agent drafts a reply for people (the conversation waits). */
async function asks(text: string): Promise<{ id: string; visitor: Visitor }> {
  const { visitor, conversationId } = await customerStarts(slice, shop, text);
  await slice.drain();
  return { id: conversationId, visitor };
}

async function drafts(id: string, client: Client = amina.client) {
  const list = await client.get(inbox(id, '/ai-drafts'));
  expect(list.status, JSON.stringify(list.body)).toBe(200);
  return list.body as { pending: Record<string, any> | null; latest: Record<string, any> | null };
}

async function pending(id: string) {
  const { pending: draft } = await drafts(id);
  expect(draft, 'a draft is waiting').not.toBeNull();
  return draft as Record<string, any>;
}

async function epochOf(id: string, client: Client = amina.client): Promise<number> {
  return (await client.get(inbox(id))).body.ownershipEpoch as number;
}

const publicTexts = async (id: string) =>
  (await authority(slice, shop, id)).messages
    .filter((m) => !m.private && m.direction === 'outgoing')
    .map((m) => m.text);

beforeAll(async () => {
  slice = await startSlice({ model: answering.model });
  shop = await connectedTenant(slice, 'drafts');
  other = await connectedTenant(slice, 'drafts-other');
  tenantId = fromPublicId('tenant', shop.tenantId);
  amina = await join(slice, shop, 'Amina Agent', 'agent');
  rayan = await join(slice, shop, 'Rayan Lead', 'supervisor');
  ana = await join(slice, shop, 'Ana Analyst', 'analyst');

  // One public and one internal source; the agent may use both, and only drafts in assist mode.
  const source = async (name: string, visibility: 'public' | 'internal', text: string) => {
    const created = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: shop.brand.id,
      name,
      visibility,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const added = await shop.owner.post(
      `/v1/admin/knowledge/sources/${created.body.id}/documents`,
      {
        title: name === 'Help centre' ? 'Delivery changes' : 'Courier contract',
        ...(name === 'Help centre' ? { url: 'https://kb.example/delivery' } : {}),
        content: { mediaType: 'text/markdown', text: `# Delivery address\n\n${text}` },
      },
    );
    expect(added.status, JSON.stringify(added.body)).toBe(202);
    return created.body.id as string;
  };
  const help = await source('Help centre', 'public', PUBLIC_TEXT);
  const team = await source('Team notes', 'internal', INTERNAL_TEXT);
  await slice.drain();
  const agent = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
  const saved = await shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
    config: { ...agent.body.published.config, mode: 'assist', knowledgeSourceIds: [help, team] },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {})).status).toBe(200);
}, 180_000);

afterAll(async () => {
  await slice?.close();
});

describe('drafting (HNV-09-05)', () => {
  it('writes a draft for people from public knowledge only, and nothing reaches Chatwoot', async () => {
    answering.state.answer = 'You can change it before dispatch [1].';
    answering.state.prompts.length = 0;
    const chat = await asks('Can I change my delivery address?');
    answering.state.answer = null;
    const draft = await pending(chat.id);
    expect(draft).toMatchObject({
      state: 'pending',
      text: 'You can change it before dispatch [1].',
      agentName: expect.any(String),
      decidedBy: null,
      sources: [
        expect.objectContaining({ title: 'Delivery changes', url: 'https://kb.example/delivery' }),
      ],
    });
    expect(draft.id).toMatch(/^aidr_/);
    expect(draft.runId).toMatch(/^run_/);
    // Internal knowledge never reached the model for a draft.
    const prompts = answering.state.prompts.join('\n');
    expect(prompts).toContain('before the order is dispatched');
    expect(prompts).not.toContain('courier 3 USD');
    // No note, no reply: Chatwoot has only what the customer wrote.
    const seen = await authority(slice, shop, chat.id);
    expect(seen.messages.some((m) => m.text?.includes('before dispatch'))).toBe(false);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    // The queue row says a draft is ready; the run that wrote it keeps no text.
    expect((await amina.client.get(inbox(chat.id))).body.aiDraftReady).toBe(true);
    const [run] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, fromPublicId('run', draft.runId))),
    );
    expect(run).toMatchObject({ kind: 'draft', outcome: 'drafted' });
    expect(JSON.stringify(run)).not.toContain('before dispatch');
  });
});

describe('reviewing', () => {
  it('sends an approved draft as the person, once, and they take the conversation', async () => {
    answering.state.answer = 'Yes, before dispatch.';
    const chat = await asks('Can I still change my address?');
    answering.state.answer = null;
    const draft = await pending(chat.id);
    const request = {
      clientRequestId: randomUUID(),
      expectedEpoch: await epochOf(chat.id),
    };
    const approved = await amina.client.post(
      inbox(chat.id, `/ai-drafts/${draft.id}/approve`),
      request,
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      draft: { state: 'approved', decidedBy: { displayName: 'Amina Agent' } },
      message: { status: 'accepted' },
    });
    await slice.drain();
    expect(await publicTexts(chat.id)).toEqual(['Yes, before dispatch.']);
    const detail = (await amina.client.get(inbox(chat.id))).body;
    expect(detail).toMatchObject({
      ownerMode: 'HUMAN_ACTIVE',
      owner: { kind: 'staff', displayName: 'Amina Agent' },
      aiDraftReady: false,
    });

    // The same request again sends nothing more.
    const again = await amina.client.post(
      inbox(chat.id, `/ai-drafts/${draft.id}/approve`),
      request,
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.message.status).toBe('duplicate');
    await slice.drain();
    expect(await publicTexts(chat.id)).toEqual(['Yes, before dispatch.']);

    // A second reviewer is told who sent it.
    const late = await rayan.client.post(inbox(chat.id, `/ai-drafts/${draft.id}/approve`), {
      clientRequestId: randomUUID(),
      expectedEpoch: await epochOf(chat.id, rayan.client),
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({
      code: 'AI_DRAFT_CLOSED',
      aiDraft: { state: 'approved', decidedBy: 'Amina Agent' },
    });
    const actions = (await audits(slice, shop, chat.id)).map((a) => a.action);
    expect(actions).toContain('ai.draft.approved');
    expect(actions).toContain('conversation.copilot_reply_sent');
  });

  it('sends an edited draft as edited, and keeps only its fingerprint', async () => {
    const chat = await asks('Do you deliver on Sundays?');
    const draft = await pending(chat.id);
    const text = 'Not on Sundays, sorry. Monday to Saturday only.';
    const edited = await amina.client.post(inbox(chat.id, `/ai-drafts/${draft.id}/approve`), {
      clientRequestId: randomUUID(),
      expectedEpoch: await epochOf(chat.id),
      text,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.draft.state).toBe('edited');
    await slice.drain();
    expect(await publicTexts(chat.id)).toEqual([text]);
    const [decision] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.aiDraftDecisions)
        .where(eq(schema.aiDraftDecisions.draftId, fromPublicId('aiDraft', draft.id))),
    );
    expect(decision?.decision).toBe('edited');
    expect(decision?.textHash?.equals(createHash('sha256').update(text).digest())).toBe(true);
  });

  it('rejects a draft with a reason and sends nothing', async () => {
    const chat = await asks('What is your returns address?');
    const draft = await pending(chat.id);
    const rejected = await amina.client.post(inbox(chat.id, `/ai-drafts/${draft.id}/reject`), {
      clientRequestId: randomUUID(),
      reason: 'wrong_tone',
      note: 'Too formal for us.',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(rejected.body.draft).toMatchObject({
      state: 'rejected',
      rejectReason: 'wrong_tone',
      decidedBy: { displayName: 'Amina Agent' },
    });
    await slice.drain();
    expect(await publicTexts(chat.id)).toEqual([]);
    const list = await drafts(chat.id);
    expect(list).toMatchObject({ pending: null, latest: { state: 'rejected' } });
    expect((await audits(slice, shop, chat.id)).map((a) => a.action)).toContain(
      'ai.draft.rejected',
    );
  });
});

describe('going stale', () => {
  it('is replaced when the customer writes again, and kept when a person claims it from the queue', async () => {
    const chat = await asks('Where is my parcel?');
    const first = await pending(chat.id);
    const more = await chat.visitor.call('POST', `/v1/widget/conversations/${chat.id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'It was due yesterday.' }],
    });
    expect(more.status, JSON.stringify(more.body)).toBe(202);
    await slice.drain();
    const second = await pending(chat.id);
    expect(second.id).not.toBe(first.id);
    const [stale] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.aiDrafts)
        .where(eq(schema.aiDrafts.id, fromPublicId('aiDraft', first.id))),
    );
    expect(stale).toMatchObject({ state: 'superseded', supersededReason: 'customer_wrote' });

    // Rayan picks it up from the queue: the draft was written for whoever would.
    const claimed = await rayan.client.post(inbox(chat.id, '/assign'), {
      to: { kind: 'me' },
      expectedEpoch: await epochOf(chat.id, rayan.client),
    });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect((await pending(chat.id)).id).toBe(second.id);

    // He hands it to Amina: it was written for him, so it goes stale.
    const handed = await rayan.client.post(inbox(chat.id, '/assign'), {
      to: { kind: 'staff', staffMemberId: amina.staffId },
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect(await drafts(chat.id)).toMatchObject({
      pending: null,
      latest: { id: second.id, state: 'superseded', supersededReason: 'owner_changed' },
    });
  });

  it('is no longer needed once a person answers by hand, or the conversation is resolved', async () => {
    const answered = await asks('Do you gift wrap?');
    await pending(answered.id);
    const reply = await amina.client.post(`/v1/conversations/${answered.id}/messages`, {
      clientMessageId: randomUUID(),
      text: 'Yes, for 2 USD.',
      expectedEpoch: await epochOf(answered.id),
    });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    await slice.drain();
    expect((await drafts(answered.id)).latest).toMatchObject({
      state: 'superseded',
      supersededReason: 'answered',
    });

    const resolved = await asks('Thanks, that is all.');
    await pending(resolved.id);
    const done = await rayan.client.post(inbox(resolved.id, '/status'), { status: 'resolved' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((await drafts(resolved.id)).latest).toMatchObject({
      state: 'superseded',
      supersededReason: 'resolved',
    });
  });
});

describe('who may decide', () => {
  it('refuses a stale draft, a colleague’s conversation, an old view, the wrong role and another tenant', async () => {
    const chat = await asks('Can I pay on delivery?');
    const draft = await pending(chat.id);
    const approve = (client: Client, body: Record<string, unknown>, id = draft.id) =>
      client.post(inbox(chat.id, `/ai-drafts/${id}/approve`), {
        clientRequestId: randomUUID(),
        ...body,
      });
    // An old view of who handles it.
    const old = await approve(amina.client, { expectedEpoch: (await epochOf(chat.id)) + 5 });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('OWNERSHIP_CHANGED');
    // Amina picks it up (the draft stays); Rayan may not send it over her.
    expect(
      (
        await amina.client.post(inbox(chat.id, '/assign'), {
          to: { kind: 'me' },
          expectedEpoch: await epochOf(chat.id),
        })
      ).status,
    ).toBe(200);
    const over = await approve(rayan.client, { expectedEpoch: await epochOf(chat.id) });
    expect(over.status).toBe(409);
    expect(over.body).toMatchObject({
      code: 'OWNERSHIP_CHANGED',
      currentOwner: { kind: 'staff', displayName: 'Amina Agent' },
    });
    const rejectOver = await rayan.client.post(inbox(chat.id, `/ai-drafts/${draft.id}/reject`), {
      clientRequestId: randomUUID(),
      reason: 'other',
    });
    expect(rejectOver.status).toBe(409);
    // An analyst can read the conversation but not reply in it.
    expect((await drafts(chat.id, ana.client)).pending?.id).toBe(draft.id);
    expect((await approve(ana.client, { expectedEpoch: await epochOf(chat.id) })).status).toBe(403);
    // Another tenant sees nothing, and a made-up draft is not found.
    expect((await other.owner.get(inbox(chat.id, '/ai-drafts'))).status).toBe(404);
    expect((await approve(other.owner, { expectedEpoch: 0 })).status).toBe(404);
    expect(
      (await approve(amina.client, { expectedEpoch: await epochOf(chat.id) }, 'aidr_nope')).status,
    ).toBe(404);
    // Resolved, it is stale: approving says so.
    await amina.client.post(inbox(chat.id, '/status'), { status: 'resolved' });
    const stale = await approve(amina.client, { expectedEpoch: await epochOf(chat.id) });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      code: 'AI_DRAFT_CLOSED',
      aiDraft: { state: 'superseded', decidedBy: null },
    });
  });
});
