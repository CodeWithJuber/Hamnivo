import { fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
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

describe('connecting a mailbox (D13)', () => {
  const mailbox = (password: string) => ({
    name: 'Orders',
    address: 'orders@chan.example',
    imap: {
      address: 'imap.chan.example',
      port: 993,
      ssl: true,
      login: 'orders@chan.example',
      password,
    },
    smtp: {
      address: 'smtp.chan.example',
      port: 587,
      security: 'starttls',
      login: 'orders@chan.example',
      password: 'smtp-pass-1',
    },
  });
  let orders: Json;

  it('says which field Chatwoot refused, and records nothing', async () => {
    const before = (await channels()).body.items.length;
    const refused = await shop.owner.post(
      `/v1/admin/brands/${shop.brand.id}/channels/email`,
      mailbox('wrong-password'),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(refused.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ path: 'imap.password', message: expect.stringContaining('IMAP') }],
    });
    expect(JSON.stringify(refused.body)).not.toContain('wrong-password');
    expect((await channels()).body.items).toHaveLength(before);
  });

  it('connects it through Chatwoot, which keeps the passwords', async () => {
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/email`, {
      ...mailbox('imap-pass-1'),
      aiAnswers: false,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    orders = made.body;
    expect(orders).toMatchObject({
      kind: 'email',
      name: 'Orders',
      address: 'orders@chan.example',
      status: 'connected',
      aiAnswers: false,
      brandId: shop.brand.id,
    });
    expect((await channels()).body.items.map((c: Json) => c.id)).toContain(orders.id);
    // Settings come back from Chatwoot without any password.
    const settings = await shop.owner.get(`/v1/admin/channels/${orders.id}/email`);
    expect(settings.status).toBe(200);
    expect(settings.body).toEqual({
      name: 'Orders',
      address: 'orders@chan.example',
      imap: { address: 'imap.chan.example', port: 993, ssl: true, login: 'orders@chan.example' },
      smtp: {
        address: 'smtp.chan.example',
        port: 587,
        security: 'starttls',
        login: 'orders@chan.example',
      },
    });
    // Hamnivo stored no password anywhere it writes for this channel.
    const stored = await withTenant(slice.app, { tenantId }, async (tx) => ({
      inboxes: await tx.select().from(schema.authorityInboxes),
      audit: await tx
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, orders.id)),
    }));
    expect(stored.audit.map((a) => a.action)).toEqual(['channel.connected']);
    expect(JSON.stringify(stored)).not.toMatch(/imap-pass-1|smtp-pass-1/);
  });

  it('makes every new email a ticket, and answers no address that never reads replies', async () => {
    const inboxRef = await withTenant(slice.app, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ external: schema.authorityInboxes.externalInboxId })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, fromPublicId('inbox', orders.id)));
      return row?.external as number;
    });
    const turnOn = await shop.owner.put(`/v1/admin/channels/${orders.id}`, { aiAnswers: true });
    expect(turnOn.status, JSON.stringify(turnOn.body)).toBe(200);
    const email = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'gita@customer.example',
      subject: 'Wrong size',
      content: 'I got a small instead of a medium.',
    });
    await slice.drain();
    const control = await controlOf(email.conversationId);
    const [state] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, control?.id as string)),
    );
    expect(state).toMatchObject({ ticketSource: 'email', ticketNumber: expect.any(Number) });
    // The AI answers here: a person is not needed for this one.
    expect(control).toMatchObject({ ownerMode: 'AI_ACTIVE' });

    const bounce = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'mailer-daemon@mail.example',
      subject: 'Undelivered Mail Returned to Sender',
      content: 'Delivery failed.',
    });
    await slice.drain();
    expect(await controlOf(bounce.conversationId)).toMatchObject({ ownerMode: 'WAITING_HUMAN' });
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === bounce.conversationId,
      ),
    ).toEqual([]);
    await shop.owner.put(`/v1/admin/channels/${orders.id}`, { aiAnswers: false });
  });

  it('shows "Needs attention" when Chatwoot cannot sign in, until a new password works', async () => {
    const inboxRef = await withTenant(slice.app, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ external: schema.authorityInboxes.externalInboxId })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, fromPublicId('inbox', orders.id)));
      return row?.external as number;
    });
    slice.fake.setReauthorizationRequired(inboxRef, true);
    const found = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
    expect(found.body.items.find((c: Json) => c.id === orders.id)).toMatchObject({
      status: 'needs_attention',
      problem: expect.stringContaining('sign in'),
    });
    const { password: _imap, ...imap } = mailbox('x').imap;
    const { password: _smtp, ...smtp } = mailbox('x').smtp;
    // A port change keeps the passwords, and the problem.
    const moved = await shop.owner.put(`/v1/admin/channels/${orders.id}/email`, {
      ...mailbox('x'),
      imap: { ...imap, port: 143, ssl: false },
      smtp,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.status).toBe('needs_attention');
    const refused = await shop.owner.put(`/v1/admin/channels/${orders.id}/email`, {
      ...mailbox('wrong-password'),
      smtp,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.fields).toEqual([{ path: 'imap.password', message: expect.any(String) }]);
    const fixed = await shop.owner.put(`/v1/admin/channels/${orders.id}/email`, {
      ...mailbox('imap-pass-2'),
      smtp,
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect(fixed.body).toMatchObject({ status: 'connected', problem: null });
    const again = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
    expect(again.body.items.find((c: Json) => c.id === orders.id).status).toBe('connected');
  });
});

describe('WhatsApp and Telegram (D14, W24)', () => {
  const whatsapp = {
    name: 'Shop WhatsApp',
    phoneNumber: '+971501234567',
    phoneNumberId: '1098765',
    businessAccountId: '2234567',
    accessToken: 'EAAG-access-token-for-the-test',
  };
  let wa: Json;
  let tg: Json;
  let waInbox: number;
  let tgInbox: number;
  /** Hana's WhatsApp chat, whose 24-hour window has closed. */
  let quiet: { id: string; conversationId: number };

  const externalOf = async (channelId: string) =>
    withTenant(slice.app, { tenantId }, async (tx) => {
      const [row] = await tx
        .select({ external: schema.authorityInboxes.externalInboxId })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, fromPublicId('inbox', channelId)));
      return row?.external as number;
    });

  it('connects a WhatsApp number and gives what Meta asks for, never the token', async () => {
    const path = `/v1/admin/brands/${shop.brand.id}/channels/whatsapp`;
    const refused = await shop.owner.post(path, { ...whatsapp, accessToken: 'bad-token' });
    // The token is checked by shape first, then by Chatwoot with Meta.
    expect(refused.status).toBe(422);
    const rejected = await shop.owner.post(path, {
      ...whatsapp,
      accessToken: 'bad-token'.padEnd(20, '-'),
    });
    expect(rejected.status).toBe(422);
    const made = await shop.owner.post(path, whatsapp);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({
      channel: { kind: 'whatsapp', address: '+971501234567', aiAnswers: false },
      setup: {
        callbackUrl: `${slice.fake.url}/webhooks/whatsapp/+971501234567`,
        verifyToken: expect.any(String),
      },
    });
    wa = made.body.channel;
    waInbox = await externalOf(wa.id);
    const setup = await shop.owner.get(`/v1/admin/channels/${wa.id}/whatsapp`);
    expect(setup.body).toEqual(made.body.setup);
    const stored = await withTenant(slice.app, { tenantId }, async (tx) => ({
      inboxes: await tx.select().from(schema.authorityInboxes),
      audit: await tx.select().from(schema.auditEvents),
    }));
    expect(JSON.stringify(stored)).not.toContain(whatsapp.accessToken);
    expect(JSON.stringify(made.body)).not.toContain(whatsapp.accessToken);
  });

  it('refuses a bad WhatsApp token next to its field', async () => {
    const refused = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/whatsapp`, {
      ...whatsapp,
      phoneNumber: '+971509999999',
      accessToken: 'bad-token'.padEnd(24, '-'),
    });
    expect(refused.status).toBe(422);
    expect(refused.body.fields.map((f: Json) => f.path)).toContain('accessToken');
  });

  it('connects a Telegram bot', async () => {
    const path = `/v1/admin/brands/${shop.brand.id}/channels/telegram`;
    expect((await shop.owner.post(path, { name: 'Bot', botToken: 'not-a-token' })).status).toBe(
      422,
    );
    const made = await shop.owner.post(path, {
      name: 'Shop bot',
      botToken: '1234567:AAH-test-token-abcdefghijklmnop',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body).toMatchObject({ kind: 'telegram', address: expect.stringMatching(/^@/) });
    tg = made.body;
    tgInbox = await externalOf(tg.id);
  });

  it('lets people reply on WhatsApp for 24 hours after the customer wrote, and not after', async () => {
    const asked = await slice.fake.receiveChannelMessage(waInbox, {
      from: '+971555000111',
      name: 'Hana',
      content: 'Is the blue one in stock?',
    });
    await slice.drain();
    const listed = await shop.owner.get('/v1/inbox/conversations?channel=whatsapp');
    expect(listed.body.items).toHaveLength(1);
    const chat = listed.body.items[0];
    quiet = { id: chat.id, conversationId: asked.conversationId };
    expect(chat).toMatchObject({ channel: 'whatsapp', customer: { displayName: 'Hana' } });
    const closes = Date.parse(chat.replyWindowClosesAt);
    expect(closes - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    const reply = (text: string, visibility = 'public') =>
      shop.owner.post(`/v1/conversations/${chat.id}/messages`, {
        clientMessageId: crypto.randomUUID(),
        text,
        visibility,
      });
    const sent = await reply('Yes, in all sizes.');
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await slice.drain();
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === asked.conversationId,
      ),
    ).toHaveLength(1);

    // A day later, WhatsApp takes only template messages.
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.conversationControls)
        .set({ lastCustomerMessageAt: new Date(Date.now() - 25 * 3_600_000) })
        .where(eq(schema.conversationControls.externalConversationId, asked.conversationId)),
    );
    const late = await reply('Are you still there?');
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ code: 'CHANNEL_WINDOW_CLOSED' });
    // Notes for the team are not messages to the customer.
    expect((await reply('Customer went quiet.', 'internal')).status).toBe(202);
    const after = await shop.owner.get('/v1/inbox/conversations?channel=whatsapp');
    expect(Date.parse(after.body.items[0].replyWindowClosesAt)).toBeLessThan(Date.now());
    slice.fake.ageConversation(asked.conversationId, 25);
  });

  describe('template messages (D14)', () => {
    /** Meta's shape, as Chatwoot keeps it after syncing. */
    const orderUpdate = {
      name: 'order_update',
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your order {{2}} is on its way.' },
        { type: 'FOOTER', text: 'Shop' },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Thanks' },
            { type: 'URL', text: 'Track', url: 'https://shop.example/t/{{1}}' },
          ],
        },
      ],
    };
    const others = [
      { ...orderUpdate, name: 'pending_one', status: 'PENDING' },
      { ...orderUpdate, name: 'login_code', category: 'AUTHENTICATION' },
      {
        ...orderUpdate,
        name: 'with_photo',
        components: [{ type: 'HEADER', format: 'IMAGE' }, ...orderUpdate.components],
      },
    ];
    const values = { body: { '1': 'Hana', '2': '1042' }, buttons: { '1': '1042' } };
    const send = (template: Json, clientMessageId: string = crypto.randomUUID()) =>
      shop.owner.post(`/v1/conversations/${quiet.id}/messages`, { clientMessageId, template });
    const templatesSent = () =>
      slice.fake.outbound.filter(
        (o) => o.conversationId === quiet.conversationId && o.template !== undefined,
      );

    it('lists the templates Meta approved for the number, and says the window is closed', async () => {
      slice.fake.setWhatsappTemplates(
        waInbox,
        [orderUpdate, ...others],
        new Date('2026-10-09T08:00:00Z'),
      );
      const listed = await shop.owner.get(`/v1/conversations/${quiet.id}/whatsapp-templates`);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.body).toMatchObject({
        windowOpen: false,
        windowClosesAt: expect.any(String),
        lastSyncedAt: '2026-10-09T08:00:00.000Z',
      });
      expect(listed.body.items[0]).toEqual({
        name: 'order_update',
        language: 'en_US',
        category: 'UTILITY',
        header: null,
        body: 'Hi {{1}}, your order {{2}} is on its way.',
        footer: 'Shop',
        buttons: [
          { type: 'quick_reply', text: 'Thanks' },
          { type: 'url', text: 'Track' },
        ],
        variables: {
          header: [],
          body: ['1', '2'],
          buttons: [{ index: 1, type: 'url', label: 'Track' }],
        },
        unsupported: null,
      });
      expect(listed.body.items.slice(1).map((t: Json) => [t.name, t.unsupported])).toEqual([
        ['pending_one', 'not_approved'],
        ['login_code', 'authentication'],
        ['with_photo', 'media_header'],
      ]);
      // Only WhatsApp has templates.
      const telegram = await shop.owner.get('/v1/inbox/conversations?channel=telegram');
      const other = telegram.body.items[0]?.id;
      if (other) {
        expect((await shop.owner.get(`/v1/conversations/${other}/whatsapp-templates`)).status).toBe(
          422,
        );
      }
    });

    it('sends one after the 24 hours, with the values Chatwoot passes to Meta', async () => {
      const sent = await send({ name: 'order_update', language: 'en_US', values });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      await slice.drain();
      expect(templatesSent()).toEqual([
        expect.objectContaining({
          kind: 'channel_reply',
          template: {
            name: 'order_update',
            language: 'en_US',
            category: 'UTILITY',
            processedParams: {
              body: { '1': 'Hana', '2': '1042' },
              buttons: [{ type: 'none' }, { type: 'url', parameter: '1042' }],
            },
          },
        }),
      ]);
      // The transcript shows what the customer read.
      const runtime = await slice.worker
        .get(AuthorityRegistry)
        .get(tenantId, fromPublicId('connection', shop.connection.id));
      const messages = await runtime.authority.listMessages(String(quiet.conversationId), {
        view: 'staff',
      });
      expect(messages.at(-1)).toMatchObject({
        text: 'Hi Hana, your order 1042 is on its way.\n\nShop',
        direction: 'outgoing',
      });
      const audit = await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
          .from(schema.auditEvents)
          .where(eq(schema.auditEvents.action, 'conversation.template_sent')),
      );
      expect(audit).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({ template: 'order_update', language: 'en_US' }),
        }),
      ]);
    });

    it('refuses an unknown, unapproved or unsupported template, or a missing value', async () => {
      const fields = async (template: Json) => {
        const refused = await send(template);
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        return refused.body.fields.map((f: Json) => f.path);
      };
      expect(await fields({ name: 'nope', language: 'en_US', values })).toEqual(['template.name']);
      for (const name of ['pending_one', 'login_code', 'with_photo']) {
        expect(await fields({ name, language: 'en_US', values })).toEqual(['template.name']);
      }
      expect(
        await fields({
          name: 'order_update',
          language: 'en_US',
          values: { body: { '1': 'Hana' } },
        }),
      ).toEqual(['template.values.body.2', 'template.values.buttons.1']);
      expect(
        await fields({
          name: 'order_update',
          language: 'en_US',
          values: { ...values, body: { ...values.body, '3': 'extra' } },
        }),
      ).toEqual(['template.values.body.3']);
      // Text and a template together, or a template as a note, are refused by shape.
      const both = await shop.owner.post(`/v1/conversations/${quiet.id}/messages`, {
        clientMessageId: crypto.randomUUID(),
        text: 'Hi',
        template: { name: 'order_update', language: 'en_US', values },
      });
      expect(both.status).toBe(422);
      expect(both.body.code).toBe('VALIDATION_FAILED');
      expect(templatesSent()).toHaveLength(1);
    });

    it('sends a retry once, and refuses the same id with other values', async () => {
      const id = crypto.randomUUID();
      const template = { name: 'order_update', language: 'en_US', values };
      expect((await send(template, id)).status).toBe(202);
      const again = await send(template, id);
      expect(again.status).toBe(202);
      expect(again.body.status).toBe('duplicate');
      const changed = await send(
        { ...template, values: { ...values, body: { '1': 'Hana', '2': '9999' } } },
        id,
      );
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('IDEMPOTENCY_CONFLICT');
      await slice.drain();
      expect(templatesSent()).toHaveLength(2);
    });

    it('finds a template approved a moment ago', async () => {
      slice.fake.setWhatsappTemplates(waInbox, [
        orderUpdate,
        {
          ...orderUpdate,
          name: 'back_in_stock',
          components: [{ type: 'BODY', text: 'It is back!' }],
        },
      ]);
      const sent = await send({ name: 'back_in_stock', language: 'en_US' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    });
  });

  it('finds a reply whose answer was lost, after WhatsApp replaced its id, and sends it once', async () => {
    const asked = await slice.fake.receiveChannelMessage(waInbox, {
      from: '+971555000222',
      name: 'Yusuf',
      content: 'Do you deliver to Sharjah?',
    });
    await slice.drain();
    const control = await controlOf(asked.conversationId);
    const chatId = toPublicId('conversation', control?.id as string);
    const body = { clientMessageId: crypto.randomUUID(), text: 'Yes, every day.' };
    // Chatwoot stores and sends the reply (WhatsApp replaces its source_id), then the answer is lost.
    slice.fake.setResponseFault((method, url) =>
      method === 'POST' && /\/conversations\/\d+\/messages$/.test(url) ? 504 : null,
    );
    const failed = await shop.owner.post(`/v1/conversations/${chatId}/messages`, body);
    slice.fake.setResponseFault(null);
    expect(failed.status).toBe(503);
    const retried = await shop.owner.post(`/v1/conversations/${chatId}/messages`, body);
    expect(retried.status, JSON.stringify(retried.body)).toBe(202);
    expect(retried.body.status).toBe('duplicate');
    await slice.drain();
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === asked.conversationId,
      ),
    ).toHaveLength(1);
  });

  it('shows Telegram as its own channel, with no reply window', async () => {
    await slice.fake.receiveChannelMessage(tgInbox, {
      from: '99887766',
      name: 'Omar',
      content: 'Hello bot',
    });
    await slice.drain();
    const listed = await shop.owner.get('/v1/inbox/conversations?channel=telegram');
    expect(listed.body.items).toEqual([
      expect.objectContaining({ channel: 'telegram', replyWindowClosesAt: null }),
    ]);
  });
});
