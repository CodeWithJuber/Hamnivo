import { randomUUID } from 'node:crypto';
import type { AuthorityMessage } from '@hamnivo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatwootAuthority } from '../../src/authority.js';
import { ChatwootError, call, createChatwootClient } from '../../src/client.js';
import {
  ChatwootUserAdoptedError,
  createPlatformUser,
  type ProvisionedAccount,
  provisionAccount,
  provisionStaffUser,
} from '../../src/provisioning.js';
import { dedupeKey, parseChatwootEvent, verifyChatwootSignature } from '../../src/webhooks.js';
import { type Receiver, startReceiver } from './receiver.js';

export interface ContractTarget {
  baseUrl: string;
  platformToken: string;
  /** Address the webhook receiver binds to. */
  receiverHost: string;
  /** Base URL Chatwoot uses to reach the receiver on `port`. */
  webhookBase(port: number): string;
  close?(): Promise<void>;
}

const email = (kind: string) => `hv-${kind}-${randomUUID()}@hamnivo.invalid`;

/**
 * The ConversationAuthority contract, run against the fake Chatwoot on every test run and against
 * a real Chatwoot v4.18.0-ce when one is configured.
 */
export function authorityContract(
  name: string,
  target: () => Promise<ContractTarget>,
  enabled = true,
) {
  describe.skipIf(!enabled)(`ConversationAuthority contract: ${name}`, () => {
    let t: ContractTarget;
    let receiver: Receiver;
    let account: ProvisionedAccount;
    let staff: { userId: number; token: string };
    let authority: ChatwootAuthority;
    const inboxRef = () => String(account.inbox.id);
    const botRef = () => String(account.bot.id);
    const state: { conversationRef: string; sourceId: string; contactRef: string; keys: string[] } =
      {
        conversationRef: '',
        sourceId: '',
        contactRef: '',
        keys: [],
      };

    beforeAll(async () => {
      t = await target();
      receiver = await startReceiver(t.receiverHost);
      const base = t.webhookBase(receiver.port);
      account = await provisionAccount({
        baseUrl: t.baseUrl,
        platformToken: t.platformToken,
        accountName: `Hamnivo contract ${new Date().toISOString()}`,
        integrationEmail: email('integration'),
        webhookUrls: { account: `${base}/account`, inbox: `${base}/inbox`, bot: `${base}/bot` },
        copilotUrl: 'https://studio.hamnivo.test/embed/copilot',
      });
      staff = await provisionStaffUser({
        baseUrl: t.baseUrl,
        platformToken: t.platformToken,
        accountId: account.accountId,
        name: 'Sara Agent',
        email: email('staff'),
        role: 'agent',
      });
      const admin = createChatwootClient({ baseUrl: t.baseUrl, token: account.integration.token });
      await call(
        'addInboxMember',
        admin.POST('/api/v1/accounts/{account_id}/inbox_members', {
          params: { path: { account_id: account.accountId } },
          body: { inbox_id: account.inbox.id, user_ids: [staff.userId] } as never,
        }) as never,
      );
      authority = new ChatwootAuthority({
        baseUrl: t.baseUrl,
        accountId: account.accountId,
        integrationToken: account.integration.token,
        botToken: (ref) => {
          if (ref !== botRef()) throw new Error(`unknown bot ${ref}`);
          return account.bot.token;
        },
        staffToken: async (ref) => {
          if (ref !== String(staff.userId)) throw new Error(`unknown staff user ${ref}`);
          return staff.token;
        },
        inbox: (ref) => {
          if (ref !== inboxRef()) throw new Error(`unknown inbox ${ref}`);
          return { identifier: account.inbox.identifier, hmacToken: account.inbox.hmacToken };
        },
      });
    });

    afterAll(async () => {
      await receiver?.close();
      await t?.close?.();
    });

    it('provisions an account wired to Hamnivo', () => {
      expect(account.accountId).toBeGreaterThan(0);
      expect(account.integration.token).toBeTruthy();
      expect(account.inbox).toMatchObject({
        identifier: expect.any(String),
        hmacToken: expect.any(String),
        webhookSecret: expect.any(String),
      });
      expect(account.bot.token).toBeTruthy();
      expect(account.bot.webhookSecret).toBeTruthy();
      expect(account.accountWebhook.secret).toBeTruthy();
      expect(account.dashboardAppId).toEqual(expect.any(Number));
      // Every credential is distinct: each webhook source signs with its own secret.
      const secrets = [
        account.inbox.webhookSecret,
        account.bot.webhookSecret,
        account.accountWebhook.secret,
      ];
      expect(new Set(secrets).size).toBe(3);
    });

    it('refuses to adopt a Chatwoot user it did not create', async () => {
      const platform = createChatwootClient({ baseUrl: t.baseUrl, token: t.platformToken });
      const address = email('adopt');
      await createPlatformUser(platform, { name: 'First', email: address });
      await expect(
        createPlatformUser(platform, { name: 'Second', email: address }),
      ).rejects.toBeInstanceOf(ChatwootUserAdoptedError);
    });

    it('creates contacts idempotently per source id and rejects a forged identity', async () => {
      const sourceId = randomUUID();
      const identifier = `hv:brand_contract:${randomUUID()}`;
      const first = await authority.ensureContact({
        inboxRef: inboxRef(),
        identifier,
        sourceId,
        name: 'Ayesha',
      });
      const again = await authority.ensureContact({
        inboxRef: inboxRef(),
        identifier,
        sourceId,
        name: 'Ayesha',
      });
      expect(again).toEqual(first);
      expect(first.sourceId).toBe(sourceId);
      Object.assign(state, { sourceId, contactRef: first.contactRef });

      const forged = new ChatwootAuthority({
        baseUrl: t.baseUrl,
        accountId: account.accountId,
        integrationToken: account.integration.token,
        botToken: () => account.bot.token,
        inbox: () => ({ identifier: account.inbox.identifier, hmacToken: 'not-the-inbox-token' }),
      });
      await expect(
        forged.ensureContact({
          inboxRef: inboxRef(),
          identifier: `hv:brand_contract:${randomUUID()}`,
          sourceId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ChatwootError);
    });

    it('opens conversations owned by the Hamnivo bot', async () => {
      const { conversationRef } = await authority.openConversation({
        inboxRef: inboxRef(),
        contactSourceId: state.sourceId,
        attributes: { hv_conversation: 'cnv_contract' },
      });
      state.conversationRef = conversationRef;
      const s = await authority.getState(conversationRef);
      expect(s).toMatchObject({
        ref: conversationRef,
        inboxRef: inboxRef(),
        contactRef: state.contactRef,
        status: 'pending',
        owner: { kind: 'bot', botRef: botRef() },
        attributes: { hv_conversation: 'cnv_contract' },
      });
      expect(s.version).toBeGreaterThan(1_700_000_000);
    });

    it('writes customer, AI and staff-lane messages with keys and true authors', async () => {
      const ref = state.conversationRef;
      const customerKey = `hv1:m:${randomUUID()}`;
      const aiKey = `hv1:p:${randomUUID()}`;
      const noteKey = `hv1:n:${randomUUID()}`;
      state.keys.push(customerKey, aiKey, noteKey);

      const customer = await authority.appendMessage({
        conversationRef: ref,
        key: customerKey,
        author: { kind: 'customer' },
        visibility: 'public',
        text: 'Assalamu alaikum, where is my order?',
        contentAttributes: { hv: { v: 1 } },
      });
      expect(customer.message).toMatchObject({
        key: customerKey,
        direction: 'incoming',
        private: false,
        sender: { kind: 'contact', ref: state.contactRef },
        contentAttributes: { hv: { v: 1 } },
      });
      const ai = await authority.appendMessage({
        conversationRef: ref,
        key: aiKey,
        author: { kind: 'bot', botRef: botRef() },
        visibility: 'public',
        text: 'Wa alaikum assalam! Let me check.',
      });
      expect(ai.message).toMatchObject({
        key: aiKey,
        direction: 'outgoing',
        sender: { kind: 'bot', ref: botRef() },
      });
      const note = await authority.appendMessage({
        conversationRef: ref,
        key: noteKey,
        author: { kind: 'integration' },
        visibility: 'private',
        text: 'Handoff packet: order #1042, customer asked twice.',
      });
      expect(note.message).toMatchObject({
        key: noteKey,
        private: true,
        sender: { kind: 'user', ref: String(account.integration.userId) },
      });

      const staffView = await authority.listMessages(ref, { view: 'staff' });
      expect(staffView.map((m) => m.key)).toEqual([customerKey, aiKey, noteKey]);
      const customerView = await authority.listMessages(ref, {
        view: 'customer',
        contactSourceId: state.sourceId,
        inboxRef: inboxRef(),
      });
      expect(customerView.map((m) => m.text)).toEqual([customer.message.text, ai.message.text]);
      expect(customerView.every((m) => !m.private)).toBe(true);
    });

    it('finds a message by key beyond the first page, and reports absent keys', async () => {
      const ref = state.conversationRef;
      for (let i = 0; i < 22; i += 1) {
        await authority.appendMessage({
          conversationRef: ref,
          key: `hv1:p:${randomUUID()}`,
          author: { kind: 'bot', botRef: botRef() },
          visibility: 'public',
          text: `Update ${i + 1}`,
        });
      }
      const found = await authority.findByKey(ref, state.keys[0] as string);
      expect(found).toMatchObject({ key: state.keys[0], direction: 'incoming' });
      expect(await authority.findByKey(ref, `hv1:m:${randomUUID()}`)).toBeNull();
      const recent = await authority.findByKey(ref, `hv1:m:${randomUUID()}`, new Date());
      expect(recent).toBeNull();
      const page = await authority.listMessages(ref, {
        view: 'staff',
        after: String(Number(found?.ref)),
      });
      expect(page.length).toBe(24);
    });

    it('hands off, lets staff take over and returns to AI', async () => {
      const ref = state.conversationRef;
      // The bot lets go: open, nobody owns it (Chatwoot's bot handoff).
      await authority.setStatus(ref, 'open', { kind: 'bot', botRef: botRef() });
      expect(await authority.getState(ref)).toMatchObject({
        status: 'open',
        owner: { kind: 'none' },
      });

      const staffRef = String(staff.userId);
      await authority.setOwner(
        ref,
        { kind: 'user', userRef: staffRef },
        { kind: 'staff', userRef: staffRef },
      );
      expect(await authority.getState(ref)).toMatchObject({
        status: 'open',
        owner: { kind: 'user', userRef: staffRef },
      });
      const reply = await authority.appendMessage({
        conversationRef: ref,
        key: `hv1:m:${randomUUID()}`,
        author: { kind: 'staff', userRef: staffRef },
        visibility: 'public',
        text: 'Hi, Sara here. Your order ships today.',
      });
      expect(reply.message.sender).toMatchObject({ kind: 'user', ref: staffRef });

      await authority.setOwner(ref, { kind: 'bot', botRef: botRef() }, { kind: 'integration' });
      expect(await authority.getState(ref)).toMatchObject({
        status: 'pending',
        owner: { kind: 'bot', botRef: botRef() },
      });

      await authority.setOwner(ref, { kind: 'none' }, { kind: 'integration' });
      expect((await authority.getState(ref)).owner).toEqual({ kind: 'none' });

      await authority.setStatus(ref, 'resolved', { kind: 'integration' });
      expect((await authority.getState(ref)).status).toBe('resolved');
      await authority.setStatus(ref, 'open', { kind: 'integration' });
      expect((await authority.getState(ref)).status).toBe('open');
    });

    it('routes a conversation to a team and clears it, leaving the assignee as it is', async () => {
      const ref = state.conversationRef;
      const admin = createChatwootClient({ baseUrl: t.baseUrl, token: account.integration.token });
      const team = await call<{ id: number }>(
        'createTeam',
        admin.POST('/api/v1/accounts/{account_id}/teams', {
          params: { path: { account_id: account.accountId } },
          body: { name: `Billing ${randomUUID().slice(0, 8)}` } as never,
        }) as never,
      );
      const before = await authority.getState(ref);
      await authority.assignTeam(ref, String(team.id), { kind: 'integration' });
      const routed = await authority.getState(ref);
      expect(routed.teamRef).toBe(String(team.id));
      expect(routed.owner).toEqual(before.owner);
      await authority.assignTeam(ref, null, { kind: 'integration' });
      expect((await authority.getState(ref)).teamRef).toBeNull();
    });

    it('annotates conversations and signals typing', async () => {
      const ref = state.conversationRef;
      await authority.annotate(
        ref,
        { attributes: { hv_owner_mode: 'PAUSED' }, labels: ['vip', 'orders'] },
        { kind: 'integration' },
      );
      const s = await authority.getState(ref);
      expect(s.attributes).toMatchObject({ hv_owner_mode: 'PAUSED' });
      expect([...s.labels].sort()).toEqual(['orders', 'vip']);
      await authority.typing(ref, true, { kind: 'bot', botRef: botRef() });
      await authority.typing(ref, false, { kind: 'bot', botRef: botRef() });
    });

    describe('staff inbox operations, as the staff member’s own user', () => {
      const asStaff = () => ({ kind: 'staff' as const, userRef: String(staff.userId) });
      let outsider: ChatwootAuthority;

      beforeAll(async () => {
        // An agent of the same account who is not a member of the inbox.
        const other = await provisionStaffUser({
          baseUrl: t.baseUrl,
          platformToken: t.platformToken,
          accountId: account.accountId,
          name: 'Omar Outside',
          email: email('outsider'),
          role: 'agent',
        });
        outsider = new ChatwootAuthority({
          baseUrl: t.baseUrl,
          accountId: account.accountId,
          integrationToken: account.integration.token,
          botToken: () => account.bot.token,
          staffToken: async () => other.token,
          inbox: () => ({
            identifier: account.inbox.identifier,
            hmacToken: account.inbox.hmacToken,
          }),
        });
      });

      it('reads notes and activity as the staff member; others outside the inbox cannot', async () => {
        const ref = state.conversationRef;
        const page = await authority.listStaffMessages(ref, {}, asStaff());
        expect(page.length).toBeGreaterThan(0);
        expect(page.length).toBeLessThanOrEqual(20);
        const refs = page.map((m) => Number(m.ref));
        expect(refs).toEqual([...refs].sort((a, b) => a - b));
        const older = await authority.listStaffMessages(ref, { before: page[0]?.ref }, asStaff());
        expect(older.length).toBeGreaterThan(0);
        expect(older.every((m) => Number(m.ref) < Number(page[0]?.ref))).toBe(true);
        // The handoff note written earlier is private and readable by staff.
        expect([...older, ...page].some((m) => m.private && m.text?.includes('Handoff'))).toBe(
          true,
        );
        const denied = await outsider
          .listStaffMessages(ref, {}, { kind: 'staff', userRef: 'x' })
          .catch((e) => e);
        expect(denied).toMatchObject({ status: 401 });
      });

      it('finds messages by text for people who may read them', async () => {
        const hits = await authority.searchMessages('Handoff packet', 1, asStaff());
        expect(hits.some((m) => m.private && m.conversationRef === state.conversationRef)).toBe(
          true,
        );
        expect(await outsider.searchMessages('Handoff packet', 1, asStaff())).toEqual([]);
      });

      it('lists the tags an administrator defined, in lower case', async () => {
        const title = `vip-${randomUUID().slice(0, 8)}`;
        await authority.createLabel({ title: title.toUpperCase(), description: 'Important' });
        const labels = await authority.listLabels(asStaff());
        expect(labels).toContainEqual(expect.objectContaining({ title, description: 'Important' }));
        // Chatwoot itself accepts any tag on a conversation: Hamnivo checks them first.
        await authority.annotate(
          state.conversationRef,
          { labels: [title, 'free-form'] },
          asStaff(),
        );
        expect([...(await authority.getState(state.conversationRef)).labels].sort()).toEqual(
          ['free-form', title].sort(),
        );
      });

      it('lists conversation fields and replaces all attribute values on write', async () => {
        const key = `order_${randomUUID().slice(0, 8).replace(/-/g, '')}`;
        await authority.createFieldDefinition({ key, name: 'Order', type: 'list', options: ['a'] });
        const fields = await authority.listFieldDefinitions(asStaff());
        expect(fields).toContainEqual({
          key,
          name: 'Order',
          type: 'list',
          description: null,
          options: ['a'],
        });
        const ref = state.conversationRef;
        await authority.annotate(ref, { attributes: { [key]: 'a', hv_keep: 'x' } }, asStaff());
        await authority.annotate(ref, { attributes: { [key]: 'a' } }, asStaff());
        // Chatwoot replaces the whole set, so callers must merge what they keep.
        expect((await authority.getState(ref)).attributes).toEqual({ [key]: 'a' });
      });

      it('adds and searches saved replies by short code and content', async () => {
        const code = `addr${randomUUID().slice(0, 6)}`;
        const created = await authority.createSavedReply(
          {
            shortCode: code,
            content: 'Hello {{contact.name}}, you can change it before dispatch.',
          },
          asStaff(),
        );
        expect(created).toMatchObject({ shortCode: code });
        const byCode = await authority.listSavedReplies(code, asStaff());
        expect(byCode.map((r) => r.ref)).toContain(created.ref);
        const byText = await authority.listSavedReplies('before dispatch', asStaff());
        expect(byText.map((r) => r.ref)).toContain(created.ref);
      });

      it('reads the contact without the secret contact-inbox id', async () => {
        const contact = await authority.getContact(state.contactRef, asStaff());
        expect(contact).toMatchObject({ ref: state.contactRef, name: 'Ayesha' });
        expect(JSON.stringify(contact)).not.toContain(state.sourceId);
      });

      it('snoozes until a time or the next customer message, and reopens', async () => {
        const ref = state.conversationRef;
        const until = new Date(Date.now() + 3_600_000);
        await authority.snooze(ref, until, asStaff());
        const snoozed = await authority.getState(ref);
        expect(snoozed.status).toBe('snoozed');
        expect(Math.abs((snoozed.snoozedUntil?.getTime() ?? 0) - until.getTime())).toBeLessThan(
          2000,
        );
        // Snoozing again without a time keeps the earlier time (Chatwoot ignores a null).
        await authority.snooze(ref, null, asStaff());
        expect((await authority.getState(ref)).snoozedUntil).toEqual(snoozed.snoozedUntil);
        await authority.setStatus(ref, 'open', { kind: 'integration' });
        expect(await authority.getState(ref)).toMatchObject({ status: 'open', snoozedUntil: null });
        await authority.snooze(ref, null, asStaff());
        expect(await authority.getState(ref)).toMatchObject({
          status: 'snoozed',
          snoozedUntil: null,
        });
        await authority.setStatus(ref, 'open', { kind: 'integration' });
      });

      it('creates a team once, adds members once and assigns or removes it', async () => {
        const name = `Billing ${randomUUID().slice(0, 6)}`;
        const team = await authority.ensureTeam(name);
        expect(await authority.ensureTeam(name.toUpperCase())).toEqual(team);
        await authority.addTeamMembers(team.ref, [String(staff.userId)]);
        await authority.addTeamMembers(team.ref, [String(staff.userId)]);
        const ref = state.conversationRef;
        await authority.assignTeam(ref, team.ref, asStaff());
        expect((await authority.getState(ref)).teamRef).toBe(team.ref);
        await authority.assignTeam(ref, null, asStaff());
        expect((await authority.getState(ref)).teamRef).toBeNull();
      });
    });

    it('reports failures as typed errors that say whether to retry', async () => {
      const missing = await authority.getState('987654').catch((error) => error);
      expect(missing).toBeInstanceOf(ChatwootError);
      expect(missing).toMatchObject({ status: 404, retryable: false });

      const bogus = createChatwootClient({ baseUrl: t.baseUrl, token: 'not-a-token' });
      const denied = await call(
        'getConversation',
        bogus.GET('/api/v1/accounts/{account_id}/conversations/{conversation_id}', {
          params: {
            path: { account_id: account.accountId, conversation_id: Number(state.conversationRef) },
          },
        }) as never,
      ).catch((error) => error);
      expect(denied).toMatchObject({ status: 401, retryable: false });

      // Bot tokens cannot read transcripts; the adapter reads with the integration user.
      const bot = createChatwootClient({ baseUrl: t.baseUrl, token: account.bot.token });
      const botRead = await call(
        'listMessages',
        bot.GET('/api/v1/accounts/{account_id}/conversations/{conversation_id}/messages', {
          params: {
            path: { account_id: account.accountId, conversation_id: Number(state.conversationRef) },
          },
        }) as never,
      ).catch((error) => error);
      expect(botRead).toMatchObject({ status: 401 });
    });

    it('delivers signed webhooks from each source that normalize to one change', async () => {
      const key = state.keys[0] as string;
      const bodyHasKey = (r: { body: string }) =>
        r.body.includes(key) && r.body.includes('"message_created"');
      await receiver.waitFor((r) => r.path === '/account' && bodyHasKey(r));
      await receiver.waitFor((r) => r.path === '/inbox' && bodyHasKey(r));
      await receiver.waitFor((r) => r.path === '/bot' && bodyHasKey(r));

      const secretFor: Record<string, string> = {
        '/account': account.accountWebhook.secret,
        '/inbox': account.inbox.webhookSecret,
        '/bot': account.bot.webhookSecret,
      };
      const copies = receiver.received.filter(bodyHasKey);
      const events: AuthorityMessage[] = [];
      for (const r of copies) {
        const headers = {
          timestamp: r.headers['x-chatwoot-timestamp'] as string,
          signature: r.headers['x-chatwoot-signature'] as string,
        };
        expect(r.headers['x-chatwoot-delivery']).toBeTruthy();
        expect(
          verifyChatwootSignature({
            secret: secretFor[r.path] as string,
            ...headers,
            rawBody: r.body,
          }),
        ).toEqual({ ok: true });
        const other = r.path === '/bot' ? account.accountWebhook.secret : account.bot.webhookSecret;
        expect(
          verifyChatwootSignature({ secret: other, ...headers, rawBody: r.body }),
        ).toMatchObject({ ok: false });
        const event = parseChatwootEvent(JSON.parse(r.body));
        if (event.type !== 'message.created') throw new Error(`unexpected ${event.type}`);
        events.push(event.message);
      }
      expect(
        events.every((m) => m.key === key && m.conversationRef === state.conversationRef),
      ).toBe(true);
      const keys = new Set(copies.map((r) => dedupeKey(parseChatwootEvent(JSON.parse(r.body)))));
      expect(keys.size).toBe(1);

      const contact = await receiver.waitFor(
        (r) =>
          r.path === '/account' &&
          r.body.includes('"contact_created"') &&
          r.body.includes('hv:brand_contract:'),
      );
      expect(parseChatwootEvent(JSON.parse(contact[0]?.body ?? '{}'))).toMatchObject({
        type: 'contact.created',
      });
      await receiver.waitFor((r) => r.body.includes('"conversation_created"'));
    });
  });
}
