import { randomUUID } from 'node:crypto';
import { ChatwootImporter, provisionAccount } from '@hamnivo/chatwoot';
import { type FakeChatwoot, startFakeChatwoot } from '@hamnivo/chatwoot/fake';
import { fromPublicId, newPublicId, schema, withTenant } from '@hamnivo/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway } from './harness.js';
import { act, chatwootOf, dueNow, itemsOf, job, PNG } from './migration-helpers.js';
import { connectedTenant, type Slice, signUp, startSlice } from './slice-harness.js';

/**
 * Imports from another Chatwoot account (M04): the old Chatwoot is a second fake, read with an
 * access token of one of its users; the brand's own Chatwoot is the slice's fake.
 */

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let old: FakeChatwoot;
let oldAccountId: number;
let oldToken: string;
const source = { conversations: [] as number[], noteKey: '' };

async function settle(id: string, ...states: string[]) {
  for (let round = 0; round < 12; round += 1) {
    await slice.drain();
    const current = await job(shop.owner, id);
    if (states.includes(current.state)) return current;
    await dueNow(slice, shop.tenantId);
  }
  const current = await job(shop.owner, id);
  throw new Error(`job stayed ${current.state}: ${JSON.stringify(current.error)}`);
}

async function importFromOld(token = oldToken, accountId = oldAccountId) {
  const created = await shop.owner.post('/v1/admin/migrations', {
    brandId: shop.brand.id,
    source: 'chatwoot',
    connection: { baseUrl: old.url, accountId, apiToken: token },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  return created.body as Record<string, any>;
}

beforeAll(async () => {
  slice = await startSlice({
    env: { MIGRATION_SOURCE_ALLOW_PRIVATE: 'true', MIGRATION_SOURCE_MAX_CONVERSATIONS: '2' },
  });
  shop = await connectedTenant(slice, 'cwsrc', { publishAgent: false });
  tenantId = fromPublicId('tenant', shop.tenantId);
  await slice.drain();

  // The old Chatwoot: three conversations, one with an internal note and a photo.
  old = await startFakeChatwoot();
  const account = await provisionAccount({
    baseUrl: old.url,
    platformToken: old.platformToken,
    accountName: 'Northline (old helpdesk)',
    integrationEmail: `old-admin-${randomUUID()}@example.com`,
    webhookUrls: {
      account: 'http://127.0.0.1:9/a',
      inbox: 'http://127.0.0.1:9/i',
      bot: 'http://127.0.0.1:9/b',
    },
  });
  oldAccountId = account.accountId;
  oldToken = account.integration.token;
  const writer = new ChatwootImporter({
    baseUrl: old.url,
    accountId: oldAccountId,
    token: oldToken,
  });
  const { inboxId } = await writer.createImportInbox('Website chat');
  const people = [
    { name: 'Sara Nguyen', email: 'sara.nguyen@example.com' },
    { name: 'بلال أحمد', email: 'bilal@example.com' },
    { name: 'Ayesha Khan', email: 'ayesha@example.com' },
  ];
  for (const [index, person] of people.entries()) {
    const response = await fetch(`${old.url}/api/v1/accounts/${oldAccountId}/contacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', api_access_token: oldToken },
      body: JSON.stringify({ ...person, inbox_id: inboxId }),
    });
    const contact = ((await response.json()) as { payload: { contact: { id: number } } }).payload
      .contact;
    const { conversationId } = await writer.createConversation({
      inboxId,
      contactId: contact.id,
      key: `old-${index}`,
      attributes: { plan: 'gold' },
    });
    source.conversations.push(conversationId);
    await writer.postMessage({
      conversationId,
      key: `old-${index}-1`,
      direction: 'incoming',
      private: false,
      text: index === 1 ? 'مرحبًا، أين طلبي؟' : 'Hi, where is my order?',
      createdAt: new Date(`2026-07-0${index + 1}T10:00:00.000Z`),
      ...(index === 0
        ? { files: [{ name: 'photo.png', mediaType: 'image/png', bytes: PNG }] }
        : {}),
    });
    if (index === 0) {
      source.noteKey = 'old-0-note';
      await writer.postMessage({
        conversationId,
        key: source.noteKey,
        direction: 'outgoing',
        private: true,
        text: 'Internal: courier lost it.',
        createdAt: new Date('2026-07-01T10:02:00.000Z'),
      });
    }
    await writer.postMessage({
      conversationId,
      key: `old-${index}-2`,
      direction: 'outgoing',
      private: false,
      text: 'Thanks, it ships today.',
      createdAt: new Date(`2026-07-0${index + 1}T10:05:00.000Z`),
    });
    if (index !== 2) await writer.resolve(conversationId);
  }
});

afterAll(async () => {
  await old?.close();
  await slice?.close();
});

describe('Chatwoot source (M04)', () => {
  let first: Record<string, any>;

  it('keeps the token in the secret broker only, reads the account once and then revokes it', async () => {
    const before = old.requests.length;
    const created = await importFromOld();
    expect(created).toMatchObject({ source: 'chatwoot', sourceKind: 'api', state: 'scanning' });
    expect(JSON.stringify(created)).not.toContain(oldToken);
    const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.migrationJobs)
        .where(eq(schema.migrationJobs.id, fromPublicId('migration', created.id))),
    );
    expect(JSON.stringify(row?.sourceConfig)).not.toContain(oldToken);
    const [secret] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.secrets)
        .where(eq(schema.secrets.id, row?.sourceSecretId as string)),
    );
    expect(secret).toMatchObject({ kind: 'migration_source', revokedAt: null });
    expect(Buffer.from(secret?.ciphertext as Uint8Array).toString('latin1')).not.toContain(
      oldToken,
    );

    first = await settle(created.id, 'ready', 'blocked');
    expect(first.state).toBe('ready');
    // Only reads reached the old Chatwoot.
    expect(old.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    const [revoked] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.secrets)
        .where(eq(schema.secrets.id, secret?.id as string)),
    );
    expect(revoked?.revokedAt).not.toBeNull();
    const audit = await shop.owner.get('/v1/admin/audit?limit=100');
    expect(JSON.stringify(audit.body)).not.toContain(oldToken);
    expect(
      audit.body.items.some(
        (e: { action: string; target?: { id?: string } }) =>
          e.action === 'migration.source_read' && e.target?.id === created.id,
      ),
    ).toBe(true);
  });

  it('shows what the snapshot holds, the token’s access and the source’s limits', async () => {
    const preflight = first.preflight;
    expect(preflight.source.system).toBe('chatwoot');
    // Two conversations per import here: the oldest two, with their messages and the photo.
    expect(preflight.counts).toMatchObject({
      conversations: 2,
      messages: 5,
      internalNotes: 1,
      attachmentFiles: 1,
    });
    expect(preflight.checks).toContainEqual({
      code: 'source_access',
      status: 'ok',
      detail: 'administrator',
    });
    expect(preflight.limits.map((l: { code: string }) => l.code)).toEqual(
      expect.arrayContaining(['chatwoot_snapshot_cap', 'chatwoot_token_once']),
    );
    expect(preflight.issues.map((i: { code: string }) => i.code)).toContain('incomplete_package');
  });

  it('imports the snapshot like any export: original times, private notes, files, no addresses', async () => {
    await act(shop.owner, first.id, 'dry-run');
    await settle(first.id, 'dry_run_ready');
    await act(shop.owner, first.id, 'start');
    const done = await settle(first.id, 'completed');
    expect(done.progress.conversations).toMatchObject({ imported: 2 });
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const items = await itemsOf(slice, shop.tenantId, first.id);
    const target = Number(
      items.find(
        (i) =>
          i.kind === 'conversation' && i.sourceId === `conversation:${source.conversations[0]}`,
      )?.targetRef,
    );
    const messages = (await importer.listMessages(target)).filter((m) =>
      m.key?.startsWith('hv1:imp:'),
    );
    expect(
      messages.map((m) => [m.private, Number(m.contentAttributes.external_created_at)]),
    ).toEqual([
      [false, Date.parse('2026-07-01T10:00:00.000Z') / 1000],
      [true, Date.parse('2026-07-01T10:02:00.000Z') / 1000],
      [false, Date.parse('2026-07-01T10:05:00.000Z') / 1000],
    ]);
    expect(messages[0]?.attachments).toHaveLength(1);
    expect((await importer.getConversation(target))?.status).toBe('resolved');
    const contact = await importer.getContact(
      Number(items.find((i) => i.kind === 'contact')?.targetRef),
    );
    expect(contact).toMatchObject({ email: null, phone: null });
    expect(slice.fake.outbound.filter((o) => o.accountId === shop.connection.accountId)).toEqual(
      [],
    );
  });

  it('continues where the last import stopped: imported conversations are not read again', async () => {
    const second = await importFromOld();
    const checked = await settle(second.id, 'ready');
    expect(checked.preflight.counts.conversations).toBe(1);
    await act(shop.owner, second.id, 'dry-run');
    await settle(second.id, 'dry_run_ready');
    await act(shop.owner, second.id, 'start');
    const done = await settle(second.id, 'completed');
    expect(done.progress.conversations).toMatchObject({ imported: 1 });
    // All three conversations, each once.
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const imported = (await importer.listConversations({ page: 1 })).conversations.filter(
      (c) => c.attributes.hv_import_source === 'chatwoot',
    );
    expect(imported.map((c) => c.attributes.hv_source_id).sort()).toEqual(
      source.conversations.map((id) => `conversation:${id}`).sort(),
    );
    // Nothing is left to read.
    const third = await importFromOld();
    const empty = await settle(third.id, 'ready', 'blocked');
    expect(empty.preflight.counts.conversations).toBe(0);
    expect(empty.state).toBe('blocked');
    await act(shop.owner, third.id, 'cancel');
  });

  it('refuses a token that cannot read the account, and revokes it', async () => {
    const wrong = await importFromOld('not-a-real-token-123');
    const refused = await settle(wrong.id, 'rejected');
    expect(refused.error).toMatchObject({ code: 'source_denied' });
    const elsewhere = await importFromOld(oldToken, oldAccountId + 1000);
    expect((await settle(elsewhere.id, 'rejected')).error.code).toBe('source_denied');
    const secrets = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.secrets).where(eq(schema.secrets.kind, 'migration_source')),
    );
    expect(secrets.filter((s) => s.revokedAt === null)).toEqual([]);
  });
});

describe('source addresses', () => {
  it('refuses addresses inside the network unless development allows them', async () => {
    const gw = await startGateway();
    try {
      const owner = await signUp(gw, 'Rafi Owner', 'rafi@example.com');
      const tenant = await owner.post('/v1/tenants', { name: 'Rafi', slug: 'rafi' });
      owner.tenant = tenant.body.tenant.id;
      for (const baseUrl of [
        'http://chat.example.com',
        'https://127.0.0.1',
        'https://169.254.169.254',
        'https://[::1]',
        'https://user:secret@chat.example.com',
      ]) {
        const refused = await owner.post('/v1/admin/migrations', {
          // A well-formed brand ID: the address is refused before the brand is looked up.
          brandId: newPublicId('brand').publicId,
          source: 'chatwoot',
          connection: { baseUrl, accountId: 1, apiToken: 'token-12345678' },
        });
        expect(refused.status, baseUrl).toBe(422);
        expect(refused.body.fields, baseUrl).toEqual([
          expect.objectContaining({ path: 'connection.baseUrl' }),
        ]);
        expect(JSON.stringify(refused.body)).not.toContain('token-12345678');
      }
    } finally {
      await gw.close();
    }
  });
});
