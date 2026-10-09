import { randomUUID } from 'node:crypto';
import type { AuthorityAttachment } from '@hamnivo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatwootAuthority } from '../src/authority.js';
import { ChatwootError, call, createChatwootClient } from '../src/client.js';
import { type FakeChatwoot, startFakeChatwoot } from '../src/fake/index.js';
import {
  addInboxMembers,
  listInboxes,
  provisionAccount,
  provisionStaffUser,
  setInboxAgentBot,
} from '../src/provisioning.js';
import { parseChatwootEvent } from '../src/webhooks.js';
import { type Receiver, startReceiver } from './contract/receiver.js';

let fake: FakeChatwoot | undefined;
let receiver: Receiver | undefined;
afterEach(async () => {
  await fake?.close();
  await receiver?.close();
  fake = undefined;
  receiver = undefined;
});

async function setup(options: Parameters<typeof startFakeChatwoot>[0] = {}) {
  fake = await startFakeChatwoot(options);
  receiver = await startReceiver();
  const base = `http://127.0.0.1:${receiver.port}`;
  const account = await provisionAccount({
    baseUrl: fake.url,
    platformToken: fake.platformToken,
    accountName: 'Chaos',
    integrationEmail: `hv-int-${randomUUID()}@hamnivo.invalid`,
    webhookUrls: { account: `${base}/account`, inbox: `${base}/inbox`, bot: `${base}/bot` },
  });
  const authority = new ChatwootAuthority({
    baseUrl: fake.url,
    accountId: account.accountId,
    integrationToken: account.integration.token,
    botToken: () => account.bot.token,
    inbox: () => ({ identifier: account.inbox.identifier, hmacToken: account.inbox.hmacToken }),
  });
  const inboxRef = String(account.inbox.id);
  const contact = await authority.ensureContact({
    inboxRef,
    identifier: `hv:b:${randomUUID()}`,
    sourceId: randomUUID(),
  });
  const open = () => authority.openConversation({ inboxRef, contactSourceId: contact.sourceId });
  return { fake, receiver, authority, account, open };
}

describe('fake Chatwoot webhook chaos', () => {
  it('delivers every webhook twice with the same delivery id when duplicating', async () => {
    const { fake, receiver, open } = await setup({ chaos: { duplicate: 1 } });
    await open();
    await fake.flush();
    // contact_created (account) + conversation_created (account, inbox), each sent twice.
    expect(fake.deliveries.map((d) => d.outcome)).toEqual([
      'duplicated',
      'duplicated',
      'duplicated',
    ]);
    expect(receiver.received).toHaveLength(6);
    const ids = receiver.received.map((r) => r.headers['x-chatwoot-delivery']);
    expect(new Set(ids).size).toBe(3);
  });

  it('loses webhooks when dropping, like Chatwoot without retries', async () => {
    const { fake, receiver, open } = await setup({ chaos: { drop: 1 } });
    await open();
    await fake.flush();
    expect(fake.deliveries.every((d) => d.outcome === 'dropped')).toBe(true);
    expect(receiver.received).toHaveLength(0);
  });

  it('holds and then reorders deliveries reproducibly', async () => {
    const run = async (seed: number) => {
      const { fake, receiver, authority, open } = await setup({ chaos: { reorder: true, seed } });
      const { conversationRef } = await open();
      await fake.flush();
      fake.pauseDeliveries();
      for (let i = 0; i < 6; i += 1) {
        await authority.appendMessage({
          conversationRef,
          key: `hv1:m:${i}`,
          author: { kind: 'customer' },
          visibility: 'public',
          text: `message ${i}`,
        });
      }
      await fake.flush();
      const heldBack = receiver.received.filter(
        (r) => r.path === '/account' && r.body.includes('message_created'),
      );
      expect(heldBack).toHaveLength(0);
      fake.resumeDeliveries();
      await fake.flush();
      const order = receiver.received
        .filter((r) => r.path === '/account' && r.body.includes('"message_created"'))
        .map((r) => (JSON.parse(r.body) as { source_id: string }).source_id);
      await fake.close();
      await receiver.close();
      return order;
    };
    const first = await run(7);
    const again = await run(7);
    expect(first).toEqual(again);
    expect([...first].sort()).toEqual([
      'hv1:m:0',
      'hv1:m:1',
      'hv1:m:2',
      'hv1:m:3',
      'hv1:m:4',
      'hv1:m:5',
    ]);
    expect(first).not.toEqual([...first].sort());
  });
});

describe('fake Chatwoot files', () => {
  it('serves one file by redirect, from disk and by proxy, whatever its name', async () => {
    const { fake, authority, open } = await setup();
    const { conversationRef } = await open();
    const bytes = Buffer.from('%PDF-1.4\n% فاتورة\n');
    const { message } = await authority.appendMessage({
      conversationRef,
      key: 'hv1:m:file',
      author: { kind: 'customer' },
      visibility: 'public',
      text: 'Here is the invoice',
      attachments: [{ name: 'فاتورة résumé.pdf', mimeType: 'application/pdf', bytes }],
    });
    const file = message.attachments[0] as AuthorityAttachment;
    expect(file).toMatchObject({
      name: 'فاتورة résumé.pdf',
      mimeType: 'application/pdf',
      size: bytes.length,
    });
    // The address Chatwoot hands out is its own, and redirects to the storage service...
    expect(file.url?.startsWith(`${fake.url}/rails/active_storage/blobs/redirect/`)).toBe(true);
    const link = new URL(file.url as string);
    const redirect = await fetch(link, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    const disk = await fetch(new URL(redirect.headers.get('location') as string, link));
    expect(disk.status).toBe(200);
    expect(Buffer.from(await disk.arrayBuffer()).equals(bytes)).toBe(true);
    // ...while the proxy route sends the same file at once, which is what the adapter reads.
    const downloaded = await authority.downloadAttachment(file);
    expect(Buffer.from(downloaded.bytes).equals(bytes)).toBe(true);
    // A deleted message takes its files with it.
    await authority.deleteMessage(conversationRef, message.ref, { kind: 'integration' });
    await expect(authority.downloadAttachment(file)).rejects.toMatchObject({ status: 404 });
  });
});

describe('fake Chatwoot tags and saved replies', () => {
  const person = { kind: 'integration' } as const;

  it('lets only administrators manage tags; a rename follows the conversations', async () => {
    const { fake, receiver, authority, account, open } = await setup();
    const agent = await provisionStaffUser({
      baseUrl: fake.url,
      platformToken: fake.platformToken,
      accountId: account.accountId,
      name: 'Sara Agent',
      email: `hv-agent-${randomUUID()}@hamnivo.invalid`,
      role: 'agent',
    });
    const asAgent = createChatwootClient({ baseUrl: fake.url, token: agent.token });
    const label = await authority.createLabel({ title: 'VIP', description: 'Top customers' });
    expect(label).toMatchObject({ title: 'vip', description: 'Top customers' });
    const path = { account_id: account.accountId, id: Number(label.ref) };

    // An agent sees the tags but cannot change them.
    const renamedByAgent = await call(
      'updateLabel',
      asAgent.PATCH('/api/v1/accounts/{account_id}/labels/{id}', {
        params: { path },
        body: { title: 'gold' } as never,
      }) as never,
    ).catch((error) => error);
    expect(renamedByAgent).toMatchObject({ status: 401 });
    const deletedByAgent = await call(
      'deleteLabel',
      asAgent.DELETE('/api/v1/accounts/{account_id}/labels/{id}', { params: { path } }) as never,
    ).catch((error) => error);
    expect(deletedByAgent).toMatchObject({ status: 401 });
    const visible = await call<{ payload: { title: string }[] }>(
      'listLabels',
      asAgent.GET('/api/v1/accounts/{account_id}/labels', {
        params: { path: { account_id: account.accountId } },
      }) as never,
    );
    expect(visible.payload.map((l) => l.title)).toEqual(['vip']);

    // A rename reaches the conversations that have the tag, and tells the account webhook.
    const { conversationRef } = await open();
    await authority.annotate(conversationRef, { labels: ['vip', 'other'] }, person);
    await fake.flush();
    const seen = receiver.received.length;
    await authority.createLabel({ title: 'taken' });
    expect(
      await authority.updateLabel(label.ref, { title: 'taken' }).catch((error) => error),
    ).toMatchObject({ status: 422 });
    // Chatwoot's name rule: two characters or more, starting with a letter or number, no spaces,
    // and no combining marks (so Hindi vowel signs are refused).
    for (const bad of ['bad name!', 'x', '-dash', '_under', 'टैग']) {
      expect(
        await authority.updateLabel(label.ref, { title: bad }).catch((e) => e),
        bad,
      ).toMatchObject({ status: 422 });
    }
    expect(await authority.createLabel({ title: 'order-2_x' }).catch((e) => e)).toMatchObject({
      title: 'order-2_x',
    });
    const gold = await authority.updateLabel(label.ref, { title: 'Gold', description: null });
    expect(gold).toMatchObject({ ref: label.ref, title: 'gold', description: null });
    expect((await authority.getState(conversationRef)).labels).toEqual(['gold', 'other']);
    await fake.flush();
    const updates = receiver.received
      .slice(seen)
      .filter((r) => r.path === '/account' && r.body.includes('"conversation_updated"'));
    expect(updates.some((r) => r.body.includes('label_list'))).toBe(true);

    // Deleting a tag takes it off the conversations too, quietly: no webhook says so.
    await fake.flush();
    const before = receiver.received.length;
    await authority.deleteLabel(label.ref);
    expect((await authority.getState(conversationRef)).labels).toEqual(['other']);
    await fake.flush();
    expect(receiver.received).toHaveLength(before);
    expect(await authority.deleteLabel(label.ref).catch((error) => error)).toMatchObject({
      status: 404,
    });
  });

  it('changes and removes saved replies, for agents too, each short code once', async () => {
    const { fake, authority, account } = await setup();
    const agent = await provisionStaffUser({
      baseUrl: fake.url,
      platformToken: fake.platformToken,
      accountId: account.accountId,
      name: 'Sara Agent',
      email: `hv-agent-${randomUUID()}@hamnivo.invalid`,
      role: 'agent',
    });
    const hello = await authority.createSavedReply(
      { shortCode: 'hello', content: 'Hi there' },
      person,
    );
    const bye = await authority.createSavedReply({ shortCode: 'bye', content: 'Goodbye' }, person);
    expect(
      await authority
        .createSavedReply({ shortCode: 'hello', content: 'Again' }, person)
        .catch((error) => error),
    ).toMatchObject({ status: 422 });
    expect(
      await authority.updateSavedReply(bye.ref, { shortCode: 'hello' }, person).catch((e) => e),
    ).toMatchObject({ status: 422 });
    expect(
      await authority.updateSavedReply(bye.ref, { content: '  ' }, person).catch((e) => e),
    ).toMatchObject({ status: 422 });

    // Changing one thing keeps the other.
    expect(await authority.updateSavedReply(hello.ref, { content: 'Hello!' }, person)).toEqual({
      ref: hello.ref,
      shortCode: 'hello',
      content: 'Hello!',
    });
    expect(await authority.updateSavedReply(hello.ref, { shortCode: 'hi' }, person)).toEqual({
      ref: hello.ref,
      shortCode: 'hi',
      content: 'Hello!',
    });

    // Chatwoot checks no role here: an agent changes and removes them as an administrator does.
    const staff = new ChatwootAuthority({
      baseUrl: fake.url,
      accountId: account.accountId,
      integrationToken: account.integration.token,
      botToken: () => account.bot.token,
      staffToken: async () => agent.token,
      inbox: () => ({ identifier: account.inbox.identifier, hmacToken: account.inbox.hmacToken }),
    });
    const actor = { kind: 'staff', userRef: String(agent.userId) } as const;
    expect(await staff.updateSavedReply(hello.ref, { content: 'Mine now' }, actor)).toEqual({
      ref: hello.ref,
      shortCode: 'hi',
      content: 'Mine now',
    });

    // A removed one is gone, and an unknown number is not found.
    await staff.deleteSavedReply(hello.ref, actor);
    expect((await authority.listSavedReplies(undefined, person)).map((r) => r.shortCode)).toEqual([
      'bye',
    ]);
    expect(
      await authority.deleteSavedReply(hello.ref, person).catch((error) => error),
    ).toMatchObject({ status: 404 });
    expect(
      await authority.updateSavedReply('999999', { content: 'x' }, person).catch((error) => error),
    ).toMatchObject({ status: 404 });
  });
});

describe('fake Chatwoot channel inboxes', () => {
  type Json = Record<string, unknown>;
  const integration = { kind: 'integration' } as const;

  async function channelSetup() {
    const ctx = await setup();
    const admin = createChatwootClient({
      baseUrl: ctx.fake.url,
      token: ctx.account.integration.token,
    });
    const createInbox = (name: string, channel: Json) =>
      call<Json>(
        'createInbox',
        admin.POST('/api/v1/accounts/{account_id}/inboxes', {
          params: { path: { account_id: ctx.account.accountId } },
          body: { name, channel } as never,
        }) as never,
      );
    const updateInbox = (id: number, change: Json) =>
      call<Json>(
        'updateInbox',
        admin.PATCH('/api/v1/accounts/{account_id}/inboxes/{id}', {
          params: { path: { account_id: ctx.account.accountId, id } },
          body: change as never,
        }) as never,
      );
    const email = await createInbox('Support mail', {
      type: 'email',
      email: 'Support@Shop.example',
      imap_enabled: true,
      imap_address: 'imap.shop.example',
      imap_port: 993,
      imap_login: 'support@shop.example',
      imap_password: 'imap-secret-1',
      smtp_enabled: true,
      smtp_address: 'smtp.shop.example',
      smtp_port: 587,
      smtp_login: 'support@shop.example',
      smtp_password: 'smtp-secret-1',
    });
    const options = {
      baseUrl: ctx.fake.url,
      token: ctx.account.integration.token,
      accountId: ctx.account.accountId,
    };
    // Setup webhooks are delivered first, so each test counts only its own.
    await ctx.fake.flush();
    return { ...ctx, admin, createInbox, updateInbox, email, options };
  }

  const since = (receiver: Receiver, from: number, path = '/account') =>
    receiver.received
      .slice(from)
      .filter((r) => r.path === path)
      .map((r) => JSON.parse(r.body) as Json);

  it('creates email, WhatsApp and Telegram inboxes, checks them and hides credentials', async () => {
    const { createInbox, updateInbox, email, options } = await channelSetup();
    expect(email).toMatchObject({
      channel_type: 'Channel::Email',
      email: 'support@shop.example',
      imap_enabled: true,
      imap_port: 993,
      smtp_address: 'smtp.shop.example',
    });
    expect(email).not.toHaveProperty('inbox_identifier');
    expect(email).not.toHaveProperty('hmac_token');
    const whatsapp = await createInbox('WhatsApp', {
      type: 'whatsapp',
      phone_number: '+15551234567',
      provider: 'whatsapp_cloud',
      provider_config: {
        api_key: 'wa-key-1',
        phone_number_id: 'pn-1',
        business_account_id: 'ba-1',
      },
    });
    expect(whatsapp).toMatchObject({
      channel_type: 'Channel::Whatsapp',
      phone_number: '+15551234567',
      provider: 'whatsapp_cloud',
    });
    const telegram = await createInbox('Telegram', {
      type: 'telegram',
      bot_token: '123:tg-token-1',
    });
    expect(telegram).toMatchObject({
      channel_type: 'Channel::Telegram',
      bot_name: `hv_fake_${telegram.id}_bot`,
    });
    const shown = JSON.stringify([email, whatsapp, telegram]);
    for (const secret of ['imap-secret-1', 'smtp-secret-1', 'wa-key-1', 'tg-token-1']) {
      expect(shown).not.toContain(secret);
    }

    // Chatwoot's record checks, each a 422 with the message and the attribute.
    const refused = (channel: Json) => createInbox('Bad', channel).catch((error) => error);
    expect(await refused({ type: 'email' })).toMatchObject({
      status: 422,
      body: { message: 'Email can’t be blank', attributes: ['email'] },
    });
    expect(await refused({ type: 'email', email: 'support@shop.example' })).toMatchObject({
      status: 422,
      body: { attributes: ['email'] },
    });
    expect(
      await refused({
        type: 'email',
        email: 'other@shop.example',
        imap_enabled: true,
        imap_password: 'wrong-password',
      }),
    ).toMatchObject({
      status: 422,
      body: { message: 'Error while connecting to the IMAP server' },
    });
    expect(
      await refused({
        type: 'whatsapp',
        phone_number: '+15550000000',
        provider: 'whatsapp_cloud',
        provider_config: { api_key: 'k', phone_number_id: 'p' },
      }),
    ).toMatchObject({ status: 422, body: { attributes: ['provider_config'] } });
    expect(
      await refused({ type: 'whatsapp', provider: 'whatsapp_cloud', provider_config: {} }),
    ).toMatchObject({ status: 422, body: { attributes: ['phone_number'] } });
    expect(
      await refused({
        type: 'whatsapp',
        phone_number: '+15550000000',
        provider_config: { api_key: 'k', phone_number_id: 'p', business_account_id: 'b' },
      }),
    ).toMatchObject({ status: 422, body: { attributes: ['provider'] } });
    expect(await refused({ type: 'telegram' })).toMatchObject({
      status: 422,
      body: { attributes: ['bot_token'] },
    });
    expect(await refused({ type: 'telegram', bot_token: '123:tg-token-1' })).toMatchObject({
      status: 422,
      body: { message: 'Bot token has already been taken' },
    });
    expect(await refused({ type: 'line' })).toMatchObject({ status: 422 });

    // An update keeps the password it is not given, and the IMAP check applies to it.
    const id = Number(email.id);
    await updateInbox(id, { channel: { imap_enabled: false, imap_password: 'wrong-password' } });
    expect(
      await updateInbox(id, { channel: { imap_enabled: true } }).catch((error) => error),
    ).toMatchObject({ status: 422 });
    const renamed = await updateInbox(id, {
      name: 'Mail',
      enable_auto_assignment: false,
      channel: { imap_enabled: true, imap_password: 'imap-secret-2', imap_port: '143' },
    });
    expect(renamed).toMatchObject({
      name: 'Mail',
      enable_auto_assignment: false,
      imap_enabled: true,
      imap_port: 143,
    });
    expect(JSON.stringify(renamed)).not.toContain('imap-secret-2');

    // The adapter lists them with the address customers write to, ordered by name.
    expect(await listInboxes(options)).toEqual([
      { id: expect.any(Number), name: 'Hamnivo Chat', channelType: 'Channel::Api', address: null },
      { id, name: 'Mail', channelType: 'Channel::Email', address: 'support@shop.example' },
      {
        id: Number(telegram.id),
        name: 'Telegram',
        channelType: 'Channel::Telegram',
        address: `@hv_fake_${telegram.id}_bot`,
      },
      {
        id: Number(whatsapp.id),
        name: 'WhatsApp',
        channelType: 'Channel::Whatsapp',
        address: '+15551234567',
      },
    ]);
  });

  it('lists inboxes to administrators in full and to agents by membership only', async () => {
    const { fake, account, email, options } = await channelSetup();
    const agent = await provisionStaffUser({
      baseUrl: fake.url,
      platformToken: fake.platformToken,
      accountId: account.accountId,
      name: 'Sara Agent',
      email: `hv-agent-${randomUUID()}@hamnivo.invalid`,
      role: 'agent',
    });
    expect(await listInboxes({ ...options, token: agent.token })).toEqual([]);
    const admin = createChatwootClient({ baseUrl: fake.url, token: account.integration.token });
    await call(
      'addInboxMembers',
      admin.POST('/api/v1/accounts/{account_id}/inbox_members', {
        params: { path: { account_id: account.accountId } },
        body: { inbox_id: email.id, user_ids: [agent.userId] } as never,
      }) as never,
    );
    expect((await listInboxes({ ...options, token: agent.token })).map((i) => i.id)).toEqual([
      email.id,
    ]);
    expect(
      await listInboxes({ ...options, token: account.bot.token }).catch((error) => error),
    ).toMatchObject({ status: 401 });
  });

  it('makes channel inboxes as an administrator would in Chatwoot, with members', async () => {
    const { fake, account, options } = await channelSetup();
    const mail = fake.createChannelInbox(account.accountId, {
      type: 'email',
      address: 'Help@Shop.example',
    });
    const wa = fake.createChannelInbox(account.accountId, { type: 'whatsapp', name: 'WA' });
    const tg = fake.createChannelInbox(account.accountId, {
      type: 'telegram',
      address: '@shop_bot',
    });
    const listed = await listInboxes(options);
    expect(listed.find((i) => i.id === mail.id)).toMatchObject({
      name: 'Email',
      channelType: 'Channel::Email',
      address: 'help@shop.example',
    });
    expect(listed.find((i) => i.id === wa.id)).toMatchObject({
      name: 'WA',
      channelType: 'Channel::Whatsapp',
      address: expect.stringMatching(/^\+1555\d{7}$/),
    });
    expect(listed.find((i) => i.id === tg.id)).toMatchObject({ address: '@shop_bot' });
    // The same checks as the API: an address is taken once.
    expect(() =>
      fake.createChannelInbox(account.accountId, { type: 'email', address: 'help@shop.example' }),
    ).toThrow();

    // Members of a channel inbox see it and its conversations, as on an API inbox.
    const agent = await provisionStaffUser({
      baseUrl: fake.url,
      platformToken: fake.platformToken,
      accountId: account.accountId,
      name: 'Sara Agent',
      email: `hv-agent-${randomUUID()}@hamnivo.invalid`,
      role: 'agent',
    });
    const thread = await fake.receiveChannelMessage(mail.id, {
      from: 'omar@example.com',
      subject: 'Hi',
      content: 'Hello',
    });
    const asAgent = new ChatwootAuthority({
      baseUrl: fake.url,
      accountId: account.accountId,
      integrationToken: account.integration.token,
      botToken: () => account.bot.token,
      staffToken: async () => agent.token,
      inbox: () => ({ identifier: account.inbox.identifier, hmacToken: account.inbox.hmacToken }),
    });
    const staff = { kind: 'staff', userRef: String(agent.userId) } as const;
    const ref = String(thread.conversationId);
    expect(await asAgent.getState(ref, staff).catch((error) => error)).toMatchObject({
      status: 401,
    });
    await addInboxMembers({ ...options, inboxId: mail.id, userIds: [agent.userId] });
    expect(await asAgent.getState(ref, staff)).toMatchObject({ ref, subject: 'Hi' });
    expect((await listInboxes({ ...options, token: agent.token })).map((i) => i.id)).toEqual([
      mail.id,
    ]);
  });

  it('records an email as Chatwoot does and continues the thread until it is resolved', async () => {
    const { fake, receiver, authority, account, email } = await channelSetup();
    const inboxId = Number(email.id);
    const seen = receiver.received.length;
    const first = await fake.receiveChannelMessage(inboxId, {
      from: 'Omar@Example.com',
      name: 'Omar',
      subject: 'Where is order 1042?',
      content: 'It has been a week.',
    });
    await fake.flush();
    const delivered = since(receiver, seen);
    expect(delivered.map((p) => p.event)).toEqual([
      'contact_created',
      'conversation_created',
      'message_created',
    ]);
    // Channel inboxes have no inbox webhook, and no bot is attached yet.
    expect(receiver.received.slice(seen).every((r) => r.path === '/account')).toBe(true);
    const created = delivered[1] as Json;
    expect(created).toMatchObject({
      id: first.conversationId,
      inbox_id: inboxId,
      channel: 'Channel::Email',
      status: 'open',
      additional_attributes: { mail_subject: 'Where is order 1042?' },
      meta: { sender: { id: first.contactId, name: 'Omar', email: 'omar@example.com' } },
      contact_inbox: { source_id: 'omar@example.com' },
    });
    const event = parseChatwootEvent(delivered[2]);
    expect(event).toMatchObject({
      type: 'message.created',
      message: {
        ref: String(first.messageId),
        conversationRef: String(first.conversationId),
        direction: 'incoming',
        key: null,
        text: 'It has been a week.',
        sender: { kind: 'contact', ref: String(first.contactId) },
      },
      conversation: {
        ref: String(first.conversationId),
        inboxRef: String(inboxId),
        status: 'open',
        owner: { kind: 'none' },
        contact: { name: 'Omar', email: 'omar@example.com', phone: null },
        subject: 'Where is order 1042?',
      },
    });
    const state = await authority.getState(String(first.conversationId));
    expect(state).toMatchObject({
      subject: 'Where is order 1042?',
      contact: { email: 'omar@example.com' },
    });

    // A second email joins the same conversation, without new contact or conversation events.
    const before = receiver.received.length;
    const second = await fake.receiveChannelMessage(inboxId, {
      from: 'omar@example.com',
      content: 'Any news?',
    });
    expect(second).toMatchObject({
      conversationId: first.conversationId,
      contactId: first.contactId,
    });
    await fake.flush();
    expect(since(receiver, before).map((p) => p.event)).toEqual(['message_created']);
    // Unless a new one is asked for, or the last one was resolved.
    const separate = await fake.receiveChannelMessage(inboxId, {
      from: 'omar@example.com',
      subject: 'Another order',
      content: 'And order 1043?',
      newConversation: true,
    });
    expect(separate.conversationId).not.toBe(first.conversationId);
    expect(separate.contactId).toBe(first.contactId);
    await authority.setStatus(String(separate.conversationId), 'resolved', integration);
    const after = await fake.receiveChannelMessage(inboxId, {
      from: 'omar@example.com',
      content: 'Back to the first one',
    });
    expect(after.conversationId).toBe(first.conversationId);
    await authority.setStatus(String(first.conversationId), 'resolved', integration);
    const fresh = await fake.receiveChannelMessage(inboxId, {
      from: 'omar@example.com',
      subject: 'Hello again',
      content: 'New question',
    });
    expect([first.conversationId, separate.conversationId]).not.toContain(fresh.conversationId);
    expect((await authority.getState(String(fresh.conversationId))).status).toBe('open');

    // Every status, latest activity first, with the contact and subject.
    await fake.receiveChannelMessage(inboxId, { from: 'omar@example.com', content: 'Bump' });
    const listed = await authority.listInboxConversations(String(inboxId));
    expect(listed.map((c) => c.ref)).toEqual(
      [fresh.conversationId, first.conversationId, separate.conversationId].map(String),
    );
    expect(listed.map((c) => [c.status, c.subject])).toEqual([
      ['open', 'Hello again'],
      ['resolved', 'Where is order 1042?'],
      ['resolved', 'Another order'],
    ]);
    expect(listed.every((c) => c.contact?.email === 'omar@example.com')).toBe(true);
    expect(await authority.listInboxConversations(String(inboxId), { page: 2 })).toEqual([]);
    // The API inbox's own conversations stay apart, and API inboxes take no channel messages.
    expect(await authority.listInboxConversations(String(account.inbox.id))).toEqual([]);
    await expect(
      fake.receiveChannelMessage(account.inbox.id, { from: 'x@example.com', content: 'x' }),
    ).rejects.toThrow(/API inbox/);
  });

  it('hands new conversations to the inbox bot until it is detached', async () => {
    const { fake, receiver, account, authority, email, options } = await channelSetup();
    const inboxId = Number(email.id);
    await setInboxAgentBot({ ...options, inboxId, botId: account.bot.id });
    const seen = receiver.received.length;
    const withBot = await fake.receiveChannelMessage(inboxId, {
      from: 'layla@example.com',
      subject: 'Return',
      content: 'Can I return this?',
    });
    await fake.flush();
    expect(await authority.getState(String(withBot.conversationId))).toMatchObject({
      status: 'pending',
      owner: { kind: 'bot', botRef: String(account.bot.id) },
    });
    // The bot hears the message (Chatwoot does not send it conversation_created).
    const toBot = since(receiver, seen, '/bot');
    expect(toBot.map((p) => p.event)).toEqual(['message_created']);
    expect(parseChatwootEvent(toBot[0])).toMatchObject({
      conversation: { owner: { kind: 'bot' }, contact: { email: 'layla@example.com' } },
    });

    await setInboxAgentBot({ ...options, inboxId, botId: null });
    const withoutBot = await fake.receiveChannelMessage(inboxId, {
      from: 'nadia@example.com',
      content: 'Hello',
    });
    expect(await authority.getState(String(withoutBot.conversationId))).toMatchObject({
      status: 'open',
      owner: { kind: 'none' },
    });
    const missing = await setInboxAgentBot({ ...options, inboxId, botId: 999999 }).catch(
      (error) => error,
    );
    expect(missing).toMatchObject({ status: 404 });
  });

  it('sends public replies over the channel, with the email subject Hamnivo chose', async () => {
    const { fake, account, admin, authority, createInbox, email } = await channelSetup();
    const thread = await fake.receiveChannelMessage(Number(email.id), {
      from: 'omar@example.com',
      subject: 'Where is order 1042?',
      content: 'Hello',
    });
    const ref = String(thread.conversationId);
    const reply = (text: string, author: Parameters<typeof authority.appendMessage>[0]['author']) =>
      authority.appendMessage({
        conversationRef: ref,
        key: `hv1:m:${randomUUID()}`,
        author,
        visibility: 'public',
        text,
      });
    const first = await reply('It ships today.', { kind: 'integration' });
    await authority.appendMessage({
      conversationRef: ref,
      key: `hv1:n:${randomUUID()}`,
      author: { kind: 'integration' },
      visibility: 'private',
      text: 'Note only',
    });
    await authority.annotate(
      ref,
      { attributes: { hv_email_subject: '[T-17] Order 1042' } },
      integration,
    );
    const second = await reply('Tracking: 123', { kind: 'bot', botRef: String(account.bot.id) });
    expect(fake.outbound).toEqual([
      {
        kind: 'channel_reply',
        accountId: account.accountId,
        conversationId: thread.conversationId,
        messageId: Number(first.message.ref),
        subject: 'Re: Where is order 1042?',
      },
      {
        kind: 'channel_reply',
        accountId: account.accountId,
        conversationId: thread.conversationId,
        messageId: Number(second.message.ref),
        subject: '[T-17] Order 1042',
      },
    ]);

    // WhatsApp and Telegram replies carry no subject; their contacts are known by number or id.
    const whatsapp = await createInbox('WhatsApp', {
      type: 'whatsapp',
      phone_number: '+15551234567',
      provider: 'whatsapp_cloud',
      provider_config: { api_key: 'k', phone_number_id: 'p', business_account_id: 'b' },
    });
    const chat = await fake.receiveChannelMessage(Number(whatsapp.id), {
      from: '971501234567',
      name: 'Aisha',
      content: 'Salam',
    });
    const chatState = await authority.getState(String(chat.conversationId));
    expect(chatState).toMatchObject({
      contact: { name: 'Aisha', email: null, phone: '+971501234567' },
      subject: null,
    });
    const telegram = await createInbox('Telegram', { type: 'telegram', bot_token: '1:t' });
    const tg = await fake.receiveChannelMessage(Number(telegram.id), {
      from: '424242',
      content: 'Hi',
    });
    const contact = await call<{ payload: Json }>(
      'getContact',
      admin.GET('/api/v1/accounts/{account_id}/contacts/{id}', {
        params: { path: { account_id: account.accountId, id: tg.contactId } },
      }) as never,
    );
    expect(contact.payload).toMatchObject({
      name: '424242',
      email: null,
      phone_number: null,
      additional_attributes: { social_telegram_user_id: 424242 },
    });
    fake.outbound.length = 0;
    for (const conversationRef of [chat.conversationId, tg.conversationId].map(String)) {
      await authority.appendMessage({
        conversationRef,
        key: `hv1:m:${randomUUID()}`,
        author: { kind: 'integration' },
        visibility: 'public',
        text: 'On it',
      });
    }
    expect(fake.outbound.map((o) => [o.kind, o.conversationId, o.subject])).toEqual([
      ['channel_reply', chat.conversationId, undefined],
      ['channel_reply', tg.conversationId, undefined],
    ]);
  });
});

describe('client timeouts', () => {
  it('turns a slow Chatwoot into a retryable error', async () => {
    fake = await startFakeChatwoot({ latencyMs: 300 });
    const client = createChatwootClient({
      baseUrl: fake.url,
      token: fake.platformToken,
      timeoutMs: 50,
    });
    const error = await call(
      'createAccount',
      client.POST('/platform/api/v1/accounts', { body: { name: 'Slow' } as never }) as never,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ChatwootError);
    expect(error).toMatchObject({ status: 0, retryable: true });
  });
});
