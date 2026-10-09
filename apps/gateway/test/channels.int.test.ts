import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelPollService } from '../src/authority/channel-poll.service.js';
import { ReconcilerService } from '../src/authority/reconciler.service.js';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { customerStarts, join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Channels (ADR 0013): Hamnivo takes over the conversations Chatwoot creates on a brand's email,
 * WhatsApp and Telegram inboxes. They reach the staff inbox and routing like web chats; the AI
 * answers there only once the owner turns it on; nothing is adopted twice, and web chats never.
 */

type Json = Record<string, any>;

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let emailInbox: number;
let channelId: string;

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'chan');
  tenantId = fromPublicId('tenant', shop.tenantId);
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

const controls = () =>
  withTenant(slice.app, { tenantId }, (tx) => tx.select().from(schema.conversationControls));

const controlOf = async (externalId: number) => {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.externalConversationId, externalId)),
  );
  return row;
};

const channelLedger = (conversationId: string) =>
  withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.messageLedger)
      .where(
        and(
          eq(schema.messageLedger.conversationId, conversationId),
          like(schema.messageLedger.sourceKey, 'hv1:x:%'),
        ),
      ),
  );

/** Everything the reconciler and the channel poll follow, due now. */
async function pollNow() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.update(schema.reconcileCursors).set({ nextPollAt: sql`now() - interval '1 second'` }),
  );
  await slice.worker.get(ChannelPollService).drainOnce();
  await slice.worker.get(ReconcilerService).drainOnce();
  await slice.drain();
}

const channels = () => shop.owner.get(`/v1/admin/brands/${shop.brand.id}/channels`);
const update = (body: Json) => shop.owner.put(`/v1/admin/channels/${channelId}`, body);

describe('finding channels (ADR 0013)', () => {
  it('finds an email inbox made in Chatwoot, for the brand, with the AI off', async () => {
    expect((await channels()).body.items).toEqual([]);
    emailInbox = slice.fake.createChannelInbox(shop.connection.accountId, {
      type: 'email',
      name: 'Support email',
      address: 'help@chan.example',
    }).id;
    const found = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.items).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^inb_/),
        brandId: shop.brand.id,
        kind: 'email',
        name: 'Support email',
        address: 'help@chan.example',
        status: 'connected',
        aiAnswers: false,
        defaultTeamId: null,
        conversationsThisWeek: 0,
      }),
    ]);
    channelId = found.body.items[0].id;
    // Looking again finds nothing new.
    await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
    expect((await channels()).body.items).toHaveLength(1);
    // The web chat inbox stays the brand's only live inbox.
    const connections = await shop.owner.get('/v1/admin/authority/connections');
    expect(connections.body.items[0].inboxes.map((i: Json) => i.purpose).sort()).toEqual([
      'channel',
      'live',
    ]);
  });

  it('is managed by people who manage integrations only', async () => {
    const agent = await join(slice, shop, 'Ayaan Agent', 'agent');
    expect((await agent.client.get(`/v1/admin/brands/${shop.brand.id}/channels`)).status).toBe(403);
    expect(
      (await agent.client.put(`/v1/admin/channels/${channelId}`, { aiAnswers: true })).status,
    ).toBe(403);
  });
});

describe('adopting email conversations (ADR 0013)', () => {
  let first: { conversationId: number; messageId: number };

  it('takes over a new email conversation and gives it to people', async () => {
    first = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'amina@customer.example',
      name: 'Amina Khan',
      subject: 'Order 1042',
      content: 'My order has not arrived yet.',
    });
    await slice.drain();
    const control = await controlOf(first.conversationId);
    expect(control).toMatchObject({
      ownerMode: 'WAITING_HUMAN',
      brandId: fromPublicId('brand', shop.brand.id),
      authorityStatus: 'open',
    });
    expect(control?.lastCustomerMessageAt).not.toBeNull();
    // The customer's message is in the ledger, as a widget message would be.
    expect(await channelLedger(control?.id as string)).toEqual([
      expect.objectContaining({
        senderKind: 'customer',
        state: 'committed',
        authorityMessageId: first.messageId,
      }),
    ]);
    // Staff see it in the inbox as an email from Amina, waiting for a person.
    const listed = await shop.owner.get('/v1/inbox/conversations?channel=email');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0]).toMatchObject({ channel: 'email' });
    const detail = await shop.owner.get(`/v1/inbox/conversations/${listed.body.items[0].id}`);
    expect(detail.status).toBe(200);
    const customer = await shop.owner.get(
      `/v1/inbox/conversations/${listed.body.items[0].id}/customer`,
    );
    expect(customer.body).toMatchObject({
      displayName: 'Amina Khan',
      identity: 'anonymous',
      email: null,
      unverifiedEmail: 'amina@customer.example',
    });
    // Nobody answered for the brand: the AI is off on this channel.
    expect(slice.fake.outbound.filter((o) => o.kind === 'channel_reply')).toEqual([]);
    expect((await channels()).body.items[0]).toMatchObject({ conversationsThisWeek: 1 });
    expect((await channels()).body.items[0].lastEventAt).not.toBeNull();
  });

  it('adopts each conversation and message once, whatever arrives twice', async () => {
    await pollNow();
    await pollNow();
    expect(
      (await controls()).filter((c) => c.externalConversationId === first.conversationId),
    ).toHaveLength(1);
    const control = await controlOf(first.conversationId);
    expect(await channelLedger(control?.id as string)).toHaveLength(1);
    // A reply from the same address continues the same conversation and customer.
    const reply = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'amina@customer.example',
      content: 'Any news?',
    });
    expect(reply.conversationId).toBe(first.conversationId);
    await slice.drain();
    await pollNow();
    expect(await channelLedger(control?.id as string)).toHaveLength(2);
    const principals = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.kind, 'channel')),
    );
    expect(principals).toEqual([
      expect.objectContaining({
        channelKind: 'email',
        channelHandle: 'amina@customer.example',
        displayName: 'Amina Khan',
        email: null,
        emailVerifiedAt: null,
      }),
    ]);
  });

  it('finds a conversation whose webhooks were lost', async () => {
    slice.fake.setChaos({ drop: 1 });
    const lost = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'bilal@customer.example',
      subject: 'Refund',
      content: 'I would like a refund.',
    });
    await slice.drain();
    slice.fake.setChaos({ drop: 0 });
    expect(await controlOf(lost.conversationId)).toBeUndefined();
    await pollNow();
    await pollNow();
    const control = await controlOf(lost.conversationId);
    expect(control).toMatchObject({ ownerMode: 'WAITING_HUMAN' });
    expect(await channelLedger(control?.id as string)).toHaveLength(1);
  });

  it('never adopts web chats, which the widget records itself', async () => {
    const before = (await controls()).length;
    await customerStarts(slice, shop, 'Hello from the website');
    await slice.drain();
    await pollNow();
    expect((await controls()).length).toBe(before + 1);
  });

  it('leaves new conversations in Chatwoot while the channel is paused', async () => {
    const paused = await update({ paused: true });
    expect(paused.status, JSON.stringify(paused.body)).toBe(200);
    expect(paused.body).toMatchObject({ status: 'paused' });
    const left = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'chen@customer.example',
      content: 'Hello?',
    });
    await slice.drain();
    await pollNow();
    expect(await controlOf(left.conversationId)).toBeUndefined();
    expect((await update({ paused: false })).body.status).toBe('connected');
  });
});

describe('automations on a channel (ADR 0013)', () => {
  it("runs the brand's chat rules for an email conversation", async () => {
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/automations`, {
      name: 'New conversations are urgent',
      definition: {
        event: { type: 'chat_started', seconds: 0 },
        match: 'all',
        conditions: [],
        actions: [{ type: 'set_priority', priority: 'urgent' }],
      },
      publish: true,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const asked = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'farah@customer.example',
      subject: 'Sizes',
      content: 'Do you have this in medium?',
    });
    await slice.drain();
    await slice.drain();
    const runs = await shop.owner.get(`/v1/admin/automations/${made.body.id}/runs`);
    expect(runs.body.items).toEqual([expect.objectContaining({ outcome: 'done' })]);
    const runtime = await slice.worker
      .get(AuthorityRegistry)
      .get(tenantId, fromPublicId('connection', shop.connection.id));
    const state = await runtime.authority.getState(String(asked.conversationId));
    expect(state.priority).toBe('urgent');
  });
});

describe('the AI on a channel (ADR 0013)', () => {
  it('answers only once the owner turns it on, through the bot Chatwoot gives the inbox', async () => {
    const on = await update({ aiAnswers: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.aiAnswers).toBe(true);
    expect(
      slice.fake.requests.some(
        (r) => r.method === 'POST' && r.url.includes(`/inboxes/${emailInbox}/set_agent_bot`),
      ),
    ).toBe(true);
    const asked = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'dana@customer.example',
      subject: 'Opening hours',
      content: 'When are you open?',
      newConversation: true,
    });
    await slice.drain();
    const control = await controlOf(asked.conversationId);
    expect(control).toMatchObject({ ownerMode: 'AI_ACTIVE' });
    // The AI's reply goes out by email through Chatwoot.
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === asked.conversationId,
      ),
    ).toHaveLength(1);
  });

  it('gives new conversations to people again once it is turned off', async () => {
    const off = await update({ aiAnswers: false });
    expect(off.body.aiAnswers).toBe(false);
    const asked = await slice.fake.receiveChannelMessage(emailInbox, {
      from: 'erin@customer.example',
      content: 'Can someone call me?',
      newConversation: true,
    });
    await slice.drain();
    expect(await controlOf(asked.conversationId)).toMatchObject({ ownerMode: 'WAITING_HUMAN' });
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === asked.conversationId,
      ),
    ).toEqual([]);
  });

  it('records each change for the audit trail', async () => {
    const rows = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, channelId)),
    );
    expect(rows.map((r) => r.action)).toEqual([
      'channel.updated',
      'channel.updated',
      'channel.updated',
      'channel.updated',
    ]);
  });
});
