import { randomUUID } from 'node:crypto';
import type { AuthorityAttachment } from '@hamnivo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatwootAuthority } from '../src/authority.js';
import { ChatwootError, call, createChatwootClient } from '../src/client.js';
import { type FakeChatwoot, startFakeChatwoot } from '../src/fake/index.js';
import { provisionAccount, provisionStaffUser } from '../src/provisioning.js';
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
