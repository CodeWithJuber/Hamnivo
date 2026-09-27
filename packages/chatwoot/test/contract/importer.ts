import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createChatwootClient } from '../../src/client.js';
import { ChatwootImporter } from '../../src/migration.js';
import { type ProvisionedAccount, provisionAccount } from '../../src/provisioning.js';

export interface ImporterTarget {
  baseUrl: string;
  platformToken: string;
  /** Checks that only a fake can make (for example what Chatwoot would have emailed). */
  fake?: {
    outboundFor(accountId: number): number;
    addIntegrationHook(accountId: number, appId: string, inboxId?: number | null): void;
  };
  close?(): Promise<void>;
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * What imports rely on in Chatwoot's Application API, run against the fake on every test run and
 * against a real Chatwoot v4.18.0-ce when one is configured. The account it creates is deleted.
 */
export function importerContract(
  name: string,
  target: () => Promise<ImporterTarget>,
  enabled = true,
) {
  describe.skipIf(!enabled)(`Chatwoot importer contract: ${name}`, () => {
    let t: ImporterTarget;
    let account: ProvisionedAccount;
    let importer: ChatwootImporter;
    let inboxId = 0;
    let contactId = 0;
    let contactInboxSourceId: string | null = null;
    let conversationId = 0;
    const job = `mig_${randomUUID().replaceAll('-', '').slice(0, 26)}`;
    const identifier = `hv:imp:${job}:contact-1`;
    const keys = [0, 1, 2].map((i) => `hv1:imp:${job}:chat-1:${i}`);
    const times = [
      new Date('2026-09-20T09:12:31.000Z'),
      new Date('2026-09-20T09:17:46.000Z'),
      new Date('2026-09-20T09:24:10.000Z'),
    ];

    beforeAll(async () => {
      t = await target();
      account = await provisionAccount({
        baseUrl: t.baseUrl,
        platformToken: t.platformToken,
        accountName: `Hamnivo importer contract ${new Date().toISOString()}`,
        integrationEmail: `hv-import-${randomUUID()}@hamnivo.invalid`,
        // Nothing listens here: imports must not depend on webhooks.
        webhookUrls: {
          account: 'http://127.0.0.1:9/account',
          inbox: 'http://127.0.0.1:9/inbox',
          bot: 'http://127.0.0.1:9/bot',
        },
      });
      importer = new ChatwootImporter({
        baseUrl: t.baseUrl,
        accountId: account.accountId,
        token: account.integration.token,
      });
    });

    afterAll(async () => {
      if (account) {
        const platform = createChatwootClient({ baseUrl: t.baseUrl, token: t.platformToken });
        await call(
          'deleteAccount',
          platform.DELETE('/platform/api/v1/accounts/{account_id}', {
            params: { path: { account_id: account.accountId } },
          }) as never,
        ).catch(() => undefined);
        await call(
          'deleteUser',
          platform.DELETE('/platform/api/v1/users/{id}', {
            params: { path: { id: account.integration.userId } },
          }) as never,
        ).catch(() => undefined);
      }
      await t?.close?.();
    });

    it('creates a quiet import inbox: no webhook, bot, auto-assignment, greeting or survey', async () => {
      inboxId = (await importer.createImportInbox('Imported history')).inboxId;
      expect(inboxId).toBeGreaterThan(0);
      expect(await importer.inspectInbox(inboxId)).toEqual({
        webhookUrl: null,
        agentBot: false,
        autoAssignment: false,
        greeting: false,
        csat: false,
        workingHours: false,
        lockToSingleConversation: false,
      });
    });

    it('creates a contact without email or phone, once per identifier', async () => {
      const created = await importer.createContact({
        inboxId,
        identifier,
        name: 'Sara Nguyen',
        attributes: { hv_unverified_email: 'sara.nguyen@example.com', hv_import_source: 'tawk.to' },
      });
      contactId = created.contactId;
      contactInboxSourceId = created.contactInboxSourceId;
      const contact = await importer.getContact(contactId);
      expect(contact).toMatchObject({ email: null, phone: null, identifier, name: 'Sara Nguyen' });
      expect(contact?.attributes).toMatchObject({ hv_unverified_email: 'sara.nguyen@example.com' });
      await expect(
        importer.createContact({ inboxId, identifier, name: 'Again', attributes: {} }),
      ).rejects.toMatchObject({ status: 422 });
      expect(await importer.findContactByIdentifier(identifier)).toBe(contactId);
      expect(await importer.findContactByIdentifier(`${identifier}-missing`)).toBeNull();
    });

    it('opens a conversation that its key finds again', async () => {
      const key = `hv1:imp:${job}:c:chat-1`;
      conversationId = (
        await importer.createConversation({
          inboxId,
          contactId,
          contactInboxSourceId,
          key,
          attributes: { hv_import_source: 'tawk.to' },
        })
      ).conversationId;
      expect(await importer.findConversation(contactId, key)).toBe(conversationId);
      expect(await importer.findConversation(contactId, `${key}-other`)).toBeNull();
      const conversation = await importer.getConversation(conversationId);
      expect(conversation).toMatchObject({ inboxId, status: 'open', contactId });
      expect(conversation?.attributes).toMatchObject({ hv_import_key: key });
    });

    it('writes messages with original times, keys and privacy, in the order written', async () => {
      await importer.postMessage({
        conversationId,
        key: keys[0] as string,
        direction: 'incoming',
        private: false,
        text: 'مرحبًا، طلبي وصل تالفًا',
        createdAt: times[0] as Date,
        contentAttributes: { hv_import: { author: { kind: 'customer' } } },
      });
      await importer.postMessage({
        conversationId,
        key: keys[1] as string,
        direction: 'outgoing',
        private: true,
        text: 'Internal: replacement approved',
        createdAt: times[1] as Date,
        contentAttributes: { hv_import: { author: { kind: 'agent', name: 'Liam Davies' } } },
      });
      await importer.postMessage({
        conversationId,
        key: keys[2] as string,
        direction: 'outgoing',
        private: false,
        text: 'Thanks, Sara. A replacement is on its way.',
        createdAt: times[2] as Date,
      });
      const messages = (await importer.listMessages(conversationId)).filter((m) =>
        keys.includes(m.key ?? ''),
      );
      expect(messages.map((m) => m.key)).toEqual(keys);
      expect(messages.map((m) => [m.direction, m.private])).toEqual([
        ['incoming', false],
        ['outgoing', true],
        ['outgoing', false],
      ]);
      expect(messages.map((m) => Number(m.contentAttributes.external_created_at) * 1000)).toEqual(
        times.map((time) => time.getTime()),
      );
      expect(messages[0]?.text).toBe('مرحبًا، طلبي وصل تالفًا');
      expect(messages[1]?.contentAttributes.hv_import).toEqual({
        author: { kind: 'agent', name: 'Liam Davies' },
      });
      expect((await importer.findMessage(conversationId, keys[1] as string))?.private).toBe(true);
      expect(await importer.findMessage(conversationId, `${keys[1]}-missing`)).toBeNull();
    });

    it('uploads a file with its message and downloads the same bytes', async () => {
      const bytes = new TextEncoder().encode('%PDF-1.4\n% receipt for order 4821\n');
      const message = await importer.postMessage({
        conversationId,
        key: `hv1:imp:${job}:chat-1:3`,
        direction: 'incoming',
        private: false,
        text: 'Here is my receipt',
        createdAt: new Date('2026-09-20T09:25:00.000Z'),
        files: [{ name: 'receipt.pdf', mediaType: 'application/pdf', bytes }],
      });
      expect(message.attachments).toHaveLength(1);
      expect(message.contentAttributes.external_created_at).toBeDefined();
      const url = message.attachments[0]?.url as string;
      expect(url).toBeTruthy();
      const downloaded = await until(
        () => importer.download(url, 1024 * 1024),
        (value) => value !== null,
      );
      expect(Buffer.from(downloaded as Uint8Array).toString()).toBe(Buffer.from(bytes).toString());
    });

    it('resolves the conversation last, and nothing reaches the customer', async () => {
      await importer.resolve(conversationId);
      expect((await importer.getConversation(conversationId))?.status).toBe('resolved');
      if (t.fake) expect(t.fake.outboundFor(account.accountId)).toBe(0);
      const messages = await importer.listMessages(conversationId);
      // No greeting or survey template was added (message_type 3).
      expect(messages.filter((m) => m.direction === 'template')).toEqual([]);
    });

    it('lists automations and integrations that could act on imported conversations', async () => {
      expect(await importer.listAutomationRules()).toEqual([]);
      expect((await importer.listIntegrationHooks()).filter((h) => h.enabled)).toEqual([]);
      if (!t.fake) return;
      t.fake.addIntegrationHook(account.accountId, 'slack');
      expect(await importer.listIntegrationHooks()).toEqual([
        { app: 'slack', inboxId: null, enabled: true },
      ]);
      const admin = createChatwootClient({ baseUrl: t.baseUrl, token: account.integration.token });
      await call(
        'createAutomationRule',
        admin.POST('/api/v1/accounts/{account_id}/automation_rules', {
          params: { path: { account_id: account.accountId } },
          body: {
            name: 'Assign sales',
            event_name: 'conversation_created',
            active: true,
            conditions: [
              { attribute_key: 'inbox_id', filter_operator: 'equal_to', values: [inboxId] },
            ],
            actions: [{ action_name: 'assign_team', action_params: [1] }],
          } as never,
        }) as never,
      );
      expect(await importer.listAutomationRules()).toEqual([
        expect.objectContaining({
          name: 'Assign sales',
          active: true,
          inboxIds: [inboxId],
          excludedInboxIds: [],
        }),
      ]);
    });

    it('deletes what it created: the conversation, then the contact', async () => {
      expect(await importer.deleteConversation(conversationId)).toBe('deleted');
      await until(
        () => importer.getConversation(conversationId),
        (value) => value === null,
      );
      expect(await importer.deleteConversation(conversationId)).toBe('missing');
      expect(await importer.deleteContact(contactId)).toBe('deleted');
      await until(
        () => importer.getContact(contactId),
        (value) => value === null,
      );
      expect(await importer.deleteContact(contactId)).toBe('missing');
    });
  });
}
