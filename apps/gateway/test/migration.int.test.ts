import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { importMessageKey, readExport, readZip, writeZip } from '@hamnivo/migration-sdk';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay } from '../src/outbox/relay.service.js';
import { MaintenanceService } from '../src/worker/maintenance.service.js';
import {
  act,
  chatwootOf,
  conversations,
  dueNow,
  EICAR,
  helpdeskPackage,
  itemsOf,
  job,
  messages,
  PNG,
  tawkZip,
  upload,
} from './migration-helpers.js';
import {
  type Client,
  connectedTenant,
  type Slice,
  signUp,
  startSlice,
  Visitor,
} from './slice-harness.js';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
/** The tawk.to export checked in the preflight tests (left ready, never imported). */
let checkedJobId: string;

/** Runs the worker until the job reaches one of the states, letting retries become due. */
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

/** Uploads, checks, dry-runs and imports an export. */
async function importPackage(
  bytes: Uint8Array,
  name = 'helpdesk.zip',
  source: 'hamnivo' | 'tawk.to' = 'hamnivo',
) {
  const created = await upload(shop.owner, shop.brand.id, source, name, bytes);
  await settle(created.id, 'ready');
  await act(shop.owner, created.id, 'dry-run');
  await settle(created.id, 'dry_run_ready');
  await act(shop.owner, created.id, 'start');
  return settle(created.id, 'completed', 'failed');
}

async function count(table: typeof schema.conversationControls | typeof schema.integrationInbox) {
  return withTenant(slice.app, { tenantId }, async (tx) => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(table);
    return Number(row?.n);
  });
}

async function join(owner: Client, name: string, email: string, roleId: string) {
  const invited = await owner.post('/v1/admin/invitations', {
    email,
    roleId,
    scope: { type: 'tenant' },
    grantExpiresAt: null,
  });
  expect(invited.status, JSON.stringify(invited.body)).toBe(201);
  const person = await signUp(slice.gw, name, email);
  const accepted = await person.post('/v1/invitations/accept', { token: invited.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  person.tenant = owner.tenant;
  return person;
}

beforeAll(async () => {
  // Two conversations per worker pass: every import here continues from checkpoints.
  slice = await startSlice({ env: { MIGRATION_SLICE_CONVERSATIONS: '2' } });
  // The brand's AI agent is live, so anything imported that reached the runtime would be answered.
  shop = await connectedTenant(slice, 'mig', { publishAgent: true });
  tenantId = fromPublicId('tenant', shop.tenantId);
  await slice.drain();
});

afterAll(async () => {
  await slice?.close();
});

describe('preflight (M01)', () => {
  it('lists the sources with their fields and known limits', async () => {
    const sources = await shop.owner.get('/v1/admin/migrations/sources');
    expect(sources.status).toBe(200);
    const tawk = sources.body.items.find((s: { system: string }) => s.system === 'tawk.to');
    expect(tawk).toMatchObject({ available: true, accepts: expect.arrayContaining(['zip']) });
    expect(tawk.limits.map((l: { code: string }) => l.code)).toContain('tawk_rest_approval');
    expect(tawk.fields).toContainEqual(
      expect.objectContaining({ source: 'visitor.email', status: 'transformed' }),
    );
  });

  it('quarantines and scans the upload, then shows what it holds before anything is imported', async () => {
    const before = slice.fake.requests.length;
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'tawk.to',
      'tawk-export.zip',
      tawkZip(),
    );
    checkedJobId = created.id;
    expect(created).toMatchObject({ state: 'scanning', kind: 'import', exportAvailable: true });
    const checked = await settle(created.id, 'ready', 'blocked');
    expect(checked.state).toBe('ready');
    const preflight = checked.preflight;
    expect(preflight.counts).toEqual({
      contacts: 3,
      conversations: 4,
      messages: 11,
      internalNotes: 0,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(preflight.detected).toBeNull();
    expect(preflight.truncated).toBe(true);
    expect(preflight.blocking).toBe(false);
    expect(preflight.limits.map((l: { code: string }) => l.code)).toContain('tawk_export_cap');
    expect(preflight.fields).toContainEqual(
      expect.objectContaining({ path: 'visitor.email', status: 'transformed' }),
    );
    expect(
      Object.fromEntries(
        preflight.checks.map((c: { code: string; status: string }) => [c.code, c.status]),
      ),
    ).toEqual({
      authority_connected: 'ok',
      import_inbox: 'ok',
      authority_admin: 'ok',
      automations: 'ok',
      integrations: 'ok',
    });
    expect(preflight.issues.map((i: { code: string }) => i.code)).toEqual(
      expect.arrayContaining(['truncated', 'missing_time', 'unsupported_type', 'empty_message']),
    );
    // Checking only reads from Chatwoot.
    const writes = slice.fake.requests.slice(before).filter((r) => r.method !== 'GET');
    expect(writes).toEqual([]);
    const [file] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.migrationFiles)
        .where(eq(schema.migrationFiles.jobId, fromPublicId('migration', created.id))),
    );
    expect(file).toMatchObject({ state: 'clean', scanEngine: 'eicar', purpose: 'export' });
    // Counts, field names and IDs only: no message text.
    expect(JSON.stringify(preflight)).not.toMatch(/damaged|tracking|Leeds/);
  });

  it('refuses malware and files that are not exports, and keeps nothing of them', async () => {
    const infected = await upload(
      shop.owner,
      shop.brand.id,
      'tawk.to',
      'chat.json',
      Buffer.from(EICAR),
    );
    const rejected = await settle(infected.id, 'rejected');
    expect(rejected.error).toMatchObject({ code: 'malware' });
    expect(rejected.exportAvailable).toBe(false);
    const image = await upload(shop.owner, shop.brand.id, 'tawk.to', 'photo.png', PNG);
    expect((await settle(image.id, 'rejected')).error.code).toBe('not_supported');
  });

  it('reports a download that stopped early instead of importing part of it', async () => {
    const bytes = tawkZip();
    const cut = await upload(
      shop.owner,
      shop.brand.id,
      'tawk.to',
      'tawk-export.zip',
      bytes.slice(0, bytes.length - 40),
    );
    const rejected = await settle(cut.id, 'rejected');
    expect(rejected.error).toMatchObject({ code: 'truncated' });
  });

  it('blocks a file that comes from another tool than the one chosen', async () => {
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'tawk.to',
      'backup.zip',
      helpdeskPackage(),
    );
    const blocked = await settle(created.id, 'blocked');
    expect(blocked.preflight.detected).toBe('hamnivo');
    expect(blocked.preflight.checks).toContainEqual({
      code: 'source_mismatch',
      status: 'blocked',
      detail: 'hamnivo',
    });
    const refused = await shop.owner.post(`/v1/admin/migrations/${created.id}/dry-run`, {});
    expect(refused.status).toBe(409);
    await act(shop.owner, created.id, 'cancel');
  });

  it('reports a package with fewer records than its manifest declares', async () => {
    const files = readZip(helpdeskPackage());
    const records = Buffer.from(files.get('records.ndjson') as Uint8Array)
      .toString('utf8')
      .trimEnd()
      .split('\n');
    // The last conversation is missing, as when an export was cut short at its source.
    const kept = records.filter((line) => !/"conv-3"|"m-8"|"m-9"/.test(line));
    files.set('records.ndjson', Buffer.from(`${kept.join('\n')}\n`));
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'hamnivo',
      'short.zip',
      writeZip(files),
    );
    const checked = await settle(created.id, 'ready', 'blocked');
    expect(checked.preflight.truncated).toBe(true);
    expect(checked.preflight.issues).toContainEqual(
      expect.objectContaining({ code: 'count_mismatch', severity: 'error' }),
    );
    await act(shop.owner, created.id, 'cancel');
  });
});

describe('dry run (HNV-18-03)', () => {
  it('counts what would happen and changes nothing', async () => {
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'hamnivo',
      'helpdesk.zip',
      helpdeskPackage(),
    );
    await settle(created.id, 'ready');
    const snapshot = slice.fake.snapshot(shop.connection.accountId);
    const before = slice.fake.requests.length;
    await act(shop.owner, created.id, 'dry-run');
    const done = await settle(created.id, 'dry_run_ready');
    expect(done.dryRun).toMatchObject({
      conversations: { total: 3, ready: 3, duplicates: 0, needsReview: 0 },
      messages: { total: 9, ready: 9, internal: 1 },
      contacts: { total: 2, ready: 2 },
      attachments: { total: 3, ready: 2, needsReview: 1 },
      identity: { verified: 1, unverified: 1 },
      truncated: false,
      samples: ['conv-1', 'conv-2', 'conv-3'],
    });
    expect(slice.fake.snapshot(shop.connection.accountId)).toEqual(snapshot);
    expect(slice.fake.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(await itemsOf(slice, shop.tenantId, created.id)).toEqual([]);
    const mappings = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.externalIdMappings),
    );
    expect(mappings).toEqual([]);
    // A redacted sample of what would be imported.
    const sample = await shop.owner.get(`/v1/admin/migrations/${created.id}/samples/conv-1`);
    expect(sample.status).toBe(200);
    expect(sample.body.imported).toBeNull();
    expect(
      sample.body.source.messages.map((m: { sourceId: string; visibility: string }) => [
        m.sourceId,
        m.visibility,
      ]),
    ).toEqual([
      ['m-1', 'public'],
      ['m-2', 'internal'],
      ['m-3', 'public'],
      ['m-4', 'public'],
    ]);
    await act(shop.owner, created.id, 'cancel');
  });
});

describe('import (M02, M07, M08)', () => {
  let imported: Record<string, any>;
  let existingSara: number;
  const before = { controls: 0, intake: 0, botDeliveries: 0 };

  beforeAll(async () => {
    // Sara already wrote in through the live chat, with the same email address.
    const { runtime } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const response = await fetch(
      `${runtime.baseUrl}/api/v1/accounts/${runtime.accountId}/contacts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', api_access_token: runtime.integrationToken },
        body: JSON.stringify({ name: 'Sara N.', email: 'sara.nguyen@example.com' }),
      },
    );
    const created = (await response.json()) as { payload: { contact: { id: number } } };
    existingSara = Number(created.payload.contact.id);
    await slice.drain();
    before.controls = await count(schema.conversationControls);
    before.intake = await count(schema.integrationInbox);
    before.botDeliveries = slice.fake.deliveries.filter((d) => d.source !== 'account').length;
    imported = await importPackage(helpdeskPackage());
  });

  it('writes conversations into a quiet import inbox, with original times, order and status', async () => {
    expect(imported.state).toBe('completed');
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const connections = await shop.owner.get('/v1/admin/authority/connections');
    const inbox = connections.body.items[0].inboxes.find(
      (i: { purpose: string }) => i.purpose === 'import',
    );
    expect(await importer.inspectInbox(inbox.externalInboxId)).toEqual({
      webhookUrl: null,
      agentBot: false,
      autoAssignment: false,
      greeting: false,
      csat: false,
      workingHours: false,
      lockToSingleConversation: false,
    });
    const items = await itemsOf(slice, shop.tenantId, imported.id);
    const target = (id: string) =>
      Number(items.find((i) => i.kind === 'conversation' && i.sourceId === id)?.targetRef);
    const written = await importer.listMessages(target('conv-1'));
    const ours = written.filter((m) => m.key?.startsWith('hv1:imp:'));
    expect(ours.map((m) => m.key)).toEqual(
      ['m-1', 'm-2', 'm-3', 'm-4'].map((id) => importMessageKey(imported.id, id)),
    );
    expect(ours.map((m) => Number(m.contentAttributes.external_created_at) * 1000)).toEqual(
      messages.filter((m) => m.conversationId === 'conv-1').map((m) => Date.parse(m.createdAt)),
    );
    expect(ours.map((m) => [m.direction, m.private])).toEqual([
      ['incoming', false],
      ['outgoing', true],
      ['outgoing', false],
      ['incoming', false],
    ]);
    expect(ours[2]?.contentAttributes.hv_import).toMatchObject({
      source: 'hamnivo',
      author: { kind: 'agent', name: 'Liam Davies' },
    });
    // Resolved last, after every message was written.
    const conversation = await importer.getConversation(target('conv-1'));
    expect(conversation).toMatchObject({ status: 'resolved', inboxId: inbox.externalInboxId });
    expect(conversation?.attributes).toMatchObject({
      hv_import_source: 'hamnivo',
      hv_source_id: 'conv-1',
      hv_started_at: '2026-08-01T09:00:00.000Z',
      hv_labels: 'imported',
    });
    expect((await importer.getConversation(target('conv-2')))?.status).toBe('open');
    // Arabic and Urdu text arrives unchanged.
    const urdu = await importer.findMessage(target('conv-3'), importMessageKey(imported.id, 'm-8'));
    expect(urdu?.text).toBe('میرا ریفنڈ کب آئے گا؟');
  });

  it('keeps private notes private, and mentions in them notify nobody', async () => {
    const items = await itemsOf(slice, shop.tenantId, imported.id);
    expect(items.find((i) => i.sourceId === 'm-2')).toMatchObject({
      status: 'imported',
      private: true,
    });
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const conversation = Number(
      items.find((i) => i.kind === 'conversation' && i.sourceId === 'conv-1')?.targetRef,
    );
    const note = await importer.findMessage(conversation, importMessageKey(imported.id, 'm-2'));
    expect(note?.private).toBe(true);
    expect(note?.text).toBe('Internal: approve a replacement. Ask @Omar to ship it.');
    expect(imported.report.checks).toContainEqual({ code: 'private_kept_private', ok: true });
    expect(imported.report.kinds.note).toMatchObject({ discovered: 1, imported: 1 });
  });

  it('uploads files after scanning them; a missing or infected file is quarantined, not dropped', async () => {
    const items = await itemsOf(slice, shop.tenantId, imported.id);
    const file = (id: string) => items.find((i) => i.kind === 'attachment' && i.sourceId === id);
    expect(file('a-photo')).toMatchObject({ status: 'imported' });
    // Referenced by a message but missing from the attachments manifest.
    expect(file('a-missing')).toMatchObject({
      status: 'quarantined',
      reason: 'missing_attachment',
    });
    expect(file('a-eicar')).toMatchObject({ status: 'quarantined', reason: 'malware' });
    // Their messages still arrived, with their text.
    expect(items.find((i) => i.sourceId === 'm-4')).toMatchObject({ status: 'imported' });
    expect(items.find((i) => i.sourceId === 'm-9')).toMatchObject({ status: 'imported' });

    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const conversation = Number(
      items.find((i) => i.kind === 'conversation' && i.sourceId === 'conv-1')?.targetRef,
    );
    const photo = await importer.findMessage(conversation, importMessageKey(imported.id, 'm-1'));
    expect(photo?.attachments).toHaveLength(1);
    const bytes = await importer.download(photo?.attachments[0]?.url as string, 1_000_000);
    expect(Buffer.from(bytes as Uint8Array).equals(PNG)).toBe(true);

    const problems = await shop.owner.get(
      `/v1/admin/migrations/${imported.id}/items?status=problems`,
    );
    expect(
      problems.body.items
        .map((i: { sourceId: string; reason: string }) => [i.sourceId, i.reason])
        .sort(),
    ).toEqual([
      ['a-eicar', 'malware'],
      ['a-missing', 'missing_attachment'],
    ]);
    const csv = await shop.owner.get(`/v1/admin/migrations/${imported.id}/rejections`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.body).toContain('attachment,a-missing,conv-1,quarantined,missing_attachment,');
    expect(csv.body).not.toMatch(/receipt|damaged/);
    expect(imported.report.reasons).toEqual(
      expect.arrayContaining([
        { kind: 'attachment', reason: 'missing_attachment', count: 1 },
        { kind: 'attachment', reason: 'malware', count: 1 },
      ]),
    );
  });

  it('never matches people by typed-in email or phone, and gives Chatwoot neither', async () => {
    const items = await itemsOf(slice, shop.tenantId, imported.id);
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const saraId = Number(items.find((i) => i.sourceId === 'c-sara')?.targetRef);
    expect(saraId).not.toBe(existingSara);
    const sara = await importer.getContact(saraId);
    expect(sara).toMatchObject({ email: null, phone: null, name: 'Sara Nguyen' });
    expect(sara?.attributes).toMatchObject({
      hv_unverified_email: 'sara.nguyen@example.com',
      hv_unverified_phone: '+44 7700 900123',
      hv_src_plan: 'gold',
    });
    const bilal = await importer.getContact(
      Number(items.find((i) => i.sourceId === 'c-bilal')?.targetRef),
    );
    expect(bilal?.attributes).toMatchObject({ hv_verified_subject: 'cust_881' });
    // The person who wrote in with that email keeps their own contact and history.
    expect(await importer.getContact(existingSara)).toMatchObject({
      email: 'sara.nguyen@example.com',
    });
    expect(await importer.listContactConversations(existingSara)).toEqual([]);
  });

  it('sends nothing to customers, staff or the AI agent', async () => {
    // No reply emails or greetings (the fake records what Chatwoot would send out).
    expect(slice.fake.outbound.filter((o) => o.accountId === shop.connection.accountId)).toEqual(
      [],
    );
    // The import inbox has no webhook or bot; account webhooks about imports are dropped at intake.
    expect(slice.fake.deliveries.filter((d) => d.source !== 'account')).toHaveLength(
      before.botDeliveries,
    );
    expect(await count(schema.integrationInbox)).toBe(before.intake);
    expect(await count(schema.conversationControls)).toBe(before.controls);
    const [runs, publications, ledger] = await withTenant(slice.app, { tenantId }, async (tx) => [
      await tx.select().from(schema.runs),
      await tx.select().from(schema.publications),
      await tx.select().from(schema.messageLedger),
    ]);
    expect([runs.length, publications.length, ledger.length]).toEqual([0, 0, 0]);
    expect(imported.report.checks).toContainEqual({ code: 'nothing_sent', ok: true });
  });

  it('accounts for every object, reads a sample back from Chatwoot and passes the gate', async () => {
    expect(imported.report).toMatchObject({
      kind: 'reconciliation',
      gate: 'passed',
      kinds: {
        conversation: { discovered: 3, imported: 3 },
        message: { discovered: 8, imported: 8 },
        note: { discovered: 1, imported: 1 },
        contact: { discovered: 2, imported: 2 },
        attachment: { discovered: 3, imported: 1, quarantined: 2 },
      },
      samples: ['conv-1', 'conv-2', 'conv-3'],
    });
    expect(imported.report.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    const sample = await shop.owner.get(`/v1/admin/migrations/${imported.id}/samples/conv-1`);
    expect(sample.body.comparison).toEqual({ matches: true, problems: [] });
    expect(
      sample.body.imported.messages.map(
        (m: { sourceId: string; visibility: string; createdAt: string }) => [
          m.sourceId,
          m.visibility,
          m.createdAt,
        ],
      ),
    ).toEqual([
      ['m-1', 'public', '2026-08-01T09:00:00.000Z'],
      ['m-2', 'internal', '2026-08-01T09:02:00.000Z'],
      ['m-3', 'public', '2026-08-01T09:03:30.000Z'],
      ['m-4', 'public', '2026-08-01T09:05:00.000Z'],
    ]);
    // Redacted on both sides.
    expect(JSON.stringify(sample.body)).not.toMatch(/7700|sara\.nguyen/);
    const audit = await shop.owner.get('/v1/admin/audit?limit=200');
    const actions = audit.body.items
      .filter((e: { target?: { id?: string } }) => e.target?.id === imported.id)
      .map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'migration.created',
        'migration.checked',
        'migration.dry_run_requested',
        'migration.dry_run_done',
        'migration.started',
        'migration.import_inbox_created',
        'migration.completed',
      ]),
    );
  });

  it('skips conversations an earlier job imported (deduplication by source ID)', async () => {
    const snapshot = slice.fake.snapshot(shop.connection.accountId);
    const again = await importPackage(helpdeskPackage(), 'helpdesk-again.zip');
    expect(again.dryRun.conversations).toMatchObject({ ready: 0, duplicates: 3 });
    expect(again.report.kinds.conversation).toMatchObject({ skipped: 3, imported: 0 });
    expect(again.report.reasons).toContainEqual({
      kind: 'conversation',
      reason: 'duplicate_existing',
      count: 3,
    });
    const after = slice.fake.snapshot(shop.connection.accountId);
    expect([after.conversations, after.contacts, after.messages]).toEqual([
      snapshot.conversations,
      snapshot.contacts,
      snapshot.messages,
    ]);
  });

  it('rolls back exactly what the job created and leaves live conversations alone', async () => {
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    const live = await visitor.call('POST', '/v1/widget/conversations', {
      clientMessageId: randomUUID(),
      firstMessage: 'Hello, is my order on its way?',
    });
    expect(live.status).toBe(201);
    await slice.drain();
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const items = await itemsOf(slice, shop.tenantId, imported.id);
    const targets = items.filter((i) => i.kind === 'conversation').map((i) => Number(i.targetRef));
    const snapshot = slice.fake.snapshot(shop.connection.accountId);

    await act(shop.owner, imported.id, 'rollback');
    const rolledBack = await settle(imported.id, 'rolled_back');
    expect(rolledBack.report).toMatchObject({ kind: 'rollback', gate: 'passed' });
    expect(rolledBack.report.checks).toEqual([{ code: 'nothing_left', ok: true }]);
    for (const id of targets) expect(await importer.getConversation(id)).toBeNull();
    const after = slice.fake.snapshot(shop.connection.accountId);
    expect(snapshot.conversations - after.conversations).toBe(3);
    expect(snapshot.contacts - after.contacts).toBe(2);
    const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, fromPublicId('conversation', live.body.id))),
    );
    expect(await importer.getConversation(Number(control?.externalConversationId))).not.toBeNull();
    expect(await importer.getContact(existingSara)).not.toBeNull();
    const mappings = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.externalIdMappings)
        .where(eq(schema.externalIdMappings.jobId, fromPublicId('migration', imported.id))),
    );
    expect(mappings).toEqual([]);
    // Nothing of the export is kept after a rollback.
    const purged = (await slice.worker.get(MaintenanceService).run('purge-expired')) as Record<
      string,
      number
    >;
    expect(purged.migration_files).toBeGreaterThanOrEqual(1);
    expect((await job(shop.owner, imported.id)).exportAvailable).toBe(false);
    // A rolled-back import cannot be approved.
    const cutover = await shop.owner.post(`/v1/admin/migrations/${imported.id}/cutover`, {});
    expect(cutover.status).toBe(409);
  });
});

describe('resumable jobs (M07)', () => {
  it('survives timeouts after Chatwoot committed a write: a re-run creates no duplicates', async () => {
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'hamnivo',
      'crash.zip',
      helpdeskPackage(),
    );
    await settle(created.id, 'ready');
    await act(shop.owner, created.id, 'dry-run');
    await settle(created.id, 'dry_run_ready');
    let posts = 0;
    let opened = 0;
    // Chatwoot stores these writes but the answer is lost, like a crash right after the write.
    slice.fake.setResponseFault((method, url) => {
      if (method !== 'POST') return null;
      if (/\/conversations\/\d+\/messages$/.test(url) && ++posts === 3) return 504;
      if (/\/accounts\/\d+\/conversations$/.test(url) && ++opened === 2) return 504;
      return null;
    });
    try {
      await act(shop.owner, created.id, 'start');
      await slice.drain();
      const interrupted = await job(shop.owner, created.id);
      expect(interrupted.state).toBe('running');
      const writing = (await itemsOf(slice, shop.tenantId, created.id)).filter(
        (i) => i.status === 'writing',
      );
      expect(writing.map((i) => i.sourceId)).toContain('m-3');
      const done = await settle(created.id, 'completed');
      expect(posts).toBeGreaterThanOrEqual(3);
      expect(opened).toBeGreaterThanOrEqual(2);

      const items = await itemsOf(slice, shop.tenantId, created.id);
      expect(items.filter((i) => ['writing', 'pending'].includes(i.status))).toEqual([]);
      const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
      const all = (await importer.listConversations({ page: 1 })).conversations.filter(
        (c) => c.attributes.hv_import_job === created.id,
      );
      expect(all).toHaveLength(3);
      const written = (await Promise.all(all.map((c) => importer.listMessages(c.id))))
        .flat()
        .map((m) => m.key)
        .filter((k): k is string => Boolean(k?.startsWith(`hv1:imp:${created.id}:`)));
      expect(written).toHaveLength(9);
      expect(new Set(written).size).toBe(9);
      expect(done.report.checks).toContainEqual({ code: 'no_duplicates', ok: true });
      expect(done.report.gate).toBe('passed');
      // Nothing failed, so there is nothing to retry: imported objects are never sent again.
      const retry = await shop.owner.post(`/v1/admin/migrations/${created.id}/retry`, {});
      expect(retry.status).toBe(409);
    } finally {
      slice.fake.setResponseFault(null);
    }
    // One import inbox per brand, reused by every job.
    const connections = await shop.owner.get('/v1/admin/authority/connections');
    expect(
      connections.body.items[0].inboxes.filter((i: { purpose: string }) => i.purpose === 'import'),
    ).toHaveLength(1);
  });

  it('pauses at a checkpoint and resumes from it; a cut-short export fails the gate', async () => {
    const created = await upload(shop.owner, shop.brand.id, 'tawk.to', 'tawk.zip', tawkZip());
    await settle(created.id, 'ready');
    await act(shop.owner, created.id, 'dry-run');
    await settle(created.id, 'dry_run_ready');
    await act(shop.owner, created.id, 'start');
    // One worker pass writes two conversations, then hands over to the next pass.
    await slice.worker.get(OutboxRelay).drainOnce();
    const running = await job(shop.owner, created.id);
    expect(running.progress.checkpoint).toMatchObject({ conversation: 2, of: 4 });
    await act(shop.owner, created.id, 'pause');
    const paused = await settle(created.id, 'paused');
    expect(paused.progress.conversations).toMatchObject({
      imported: 2,
      pending: 2,
      quarantined: 1,
    });
    await act(shop.owner, created.id, 'resume');
    const done = await settle(created.id, 'completed');
    expect(done.progress.conversations).toMatchObject({ imported: 4, quarantined: 1, pending: 0 });
    // A chat declares more messages than the export holds: reported, not hidden.
    expect(done.report.checks).toContainEqual({ code: 'export_complete', ok: false });
    expect(done.report.missingFromExport).toMatchObject({ messages: 4 });
    expect(done.report.gate).toBe('failed');
    expect(done.report.reasons).toEqual(
      expect.arrayContaining([
        { kind: 'attachment', reason: 'binary_not_in_export', count: 1 },
        { kind: 'conversation', reason: 'unsupported_type', count: 1 },
      ]),
    );
    // Approving with a failed check needs an explicit acknowledgement.
    const refused = await shop.owner.post(`/v1/admin/migrations/${created.id}/cutover`, {});
    expect(refused.status).toBe(422);
    const closed = await act(shop.owner, created.id, 'cutover', {
      acknowledgeFailedChecks: true,
    });
    expect(closed.state).toBe('closed');
    expect(closed.report).toMatchObject({ acknowledged: true });
    expect(closed.report.approvedAt).not.toBeNull();
    const rollback = await shop.owner.post(`/v1/admin/migrations/${created.id}/rollback`, {});
    expect(rollback.status).toBe(409);
  });

  it('cancels at a checkpoint: what was imported stays until rolled back, the rest is reported', async () => {
    const renamed = helpdeskPackage({
      conversations: conversations.map((c) => ({
        ...c,
        id: `${c.id}-b`,
        source: { ...c.source, id: `${c.id}-b` },
      })),
      messages: messages.map((m) => ({
        ...m,
        id: `${m.id}-b`,
        conversationId: `${m.conversationId}-b`,
        attachmentIds: [],
      })),
      attachments: [],
    });
    const created = await upload(shop.owner, shop.brand.id, 'hamnivo', 'cancel.zip', renamed);
    await settle(created.id, 'ready');
    await act(shop.owner, created.id, 'dry-run');
    await settle(created.id, 'dry_run_ready');
    await act(shop.owner, created.id, 'start');
    await slice.worker.get(OutboxRelay).drainOnce();
    await act(shop.owner, created.id, 'cancel');
    const cancelled = await settle(created.id, 'cancelled');
    expect(cancelled.progress.conversations).toMatchObject({ imported: 2, pending: 1 });
    expect(cancelled.report.gate).toBe('failed');
    expect(cancelled.report.reasons).toContainEqual({
      kind: 'conversation',
      reason: 'cancelled',
      count: 1,
    });
    const snapshot = slice.fake.snapshot(shop.connection.accountId);
    await act(shop.owner, created.id, 'rollback');
    const rolledBack = await settle(created.id, 'rolled_back');
    expect(rolledBack.report).toMatchObject({ kind: 'rollback', gate: 'passed' });
    const after = slice.fake.snapshot(shop.connection.accountId);
    expect(snapshot.conversations - after.conversations).toBe(2);
    // The people were imported by an earlier job, whose conversations still use them: they stay.
    expect(after.contacts).toBe(snapshot.contacts);
  });
});

describe('access (cross-tenant and permissions)', () => {
  let other: Awaited<ReturnType<typeof connectedTenant>>;

  beforeAll(async () => {
    other = await connectedTenant(slice, 'other', { publishAgent: false });
    await slice.drain();
  });

  it('keeps each tenant’s imports invisible to the others', async () => {
    const id = checkedJobId;
    expect((await other.owner.get(`/v1/admin/migrations/${id}`)).status).toBe(404);
    expect((await other.owner.get(`/v1/admin/migrations/${id}/items`)).status).toBe(404);
    expect((await other.owner.get(`/v1/admin/migrations/${id}/samples/x`)).status).toBe(404);
    expect((await other.owner.post(`/v1/admin/migrations/${id}/dry-run`, {})).status).toBe(404);
    expect((await other.owner.post(`/v1/admin/migrations/${id}/rollback`, {})).status).toBe(404);
    expect((await other.owner.get('/v1/admin/migrations')).body.items).toEqual([]);
    const intoShop = await other.owner.post('/v1/admin/migrations', {
      brandId: shop.brand.id,
      source: 'tawk.to',
      file: { name: 'x.zip', base64: Buffer.from(tawkZip()).toString('base64') },
    });
    expect(intoShop.status).toBe(404);
  });

  it('blocks the import while an automation or integration would act on imported conversations', async () => {
    const { runtime } = await chatwootOf(slice, other.tenantId, other.connection.id);
    const rule = await fetch(
      `${runtime.baseUrl}/api/v1/accounts/${runtime.accountId}/automation_rules`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', api_access_token: runtime.integrationToken },
        body: JSON.stringify({ name: 'Auto-reply', event_name: 'message_created', active: true }),
      },
    );
    expect(rule.status).toBe(200);
    slice.fake.addIntegrationHook(other.connection.accountId, 'slack', null);
    const created = await other.owner.post('/v1/admin/migrations', {
      brandId: other.brand.id,
      source: 'hamnivo',
      file: { name: 'helpdesk.zip', base64: Buffer.from(helpdeskPackage()).toString('base64') },
    });
    expect(created.status).toBe(202);
    await slice.drain();
    const blocked = (await other.owner.get(`/v1/admin/migrations/${created.body.id}`)).body;
    expect(blocked.state).toBe('blocked');
    expect(blocked.preflight.checks).toEqual(
      expect.arrayContaining([
        { code: 'automations', status: 'blocked', detail: '1' },
        { code: 'integrations', status: 'blocked', detail: 'slack' },
      ]),
    );
    const dryRun = await other.owner.post(`/v1/admin/migrations/${created.body.id}/dry-run`, {});
    expect(dryRun.status).toBe(409);
    expect(slice.fake.snapshot(other.connection.accountId).conversations).toBe(0);
  });

  it('lets reviewers read imports but not run them; agents see nothing', async () => {
    const roles = await shop.owner.get('/v1/admin/roles');
    const roleId = (key: string) =>
      roles.body.items.find((r: { key: string }) => r.key === key)?.id as string;
    const reviewerRole = await shop.owner.post('/v1/admin/roles', {
      key: 'import_reviewer',
      name: 'Import reviewer',
      permissions: ['migration.review'],
    });
    expect(reviewerRole.status, JSON.stringify(reviewerRole.body)).toBe(201);
    const reviewer = await join(
      shop.owner,
      'Rana Reviewer',
      'rana@example.com',
      reviewerRole.body.id,
    );
    const agent = await join(shop.owner, 'Bilal Agent', 'bilal@example.com', roleId('agent'));

    expect((await reviewer.get('/v1/admin/migrations')).body.items.length).toBeGreaterThan(0);
    expect((await reviewer.get(`/v1/admin/migrations/${checkedJobId}`)).status).toBe(200);
    expect((await reviewer.get(`/v1/admin/migrations/${checkedJobId}/items`)).status).toBe(200);
    expect((await reviewer.post(`/v1/admin/migrations/${checkedJobId}/dry-run`, {})).status).toBe(
      403,
    );
    expect((await reviewer.post(`/v1/admin/migrations/${checkedJobId}/cancel`, {})).status).toBe(
      403,
    );
    const uploaded = await reviewer.post('/v1/admin/migrations', {
      brandId: shop.brand.id,
      source: 'tawk.to',
      file: { name: 'x.zip', base64: Buffer.from(tawkZip()).toString('base64') },
    });
    expect(uploaded.status).toBe(403);
    expect((await agent.get('/v1/admin/migrations')).status).toBe(403);
    expect((await agent.get(`/v1/admin/migrations/${checkedJobId}`)).status).toBe(403);
  });

  it('asks for a fresh sign-in before running an import', async () => {
    const roles = await shop.owner.get('/v1/admin/roles');
    const admin = await join(
      shop.owner,
      'Aisha Admin',
      'aisha@example.com',
      roles.body.items.find((r: { key: string }) => r.key === 'admin')?.id,
    );
    expect((await admin.get(`/v1/admin/migrations/${checkedJobId}`)).status).toBe(200);
    await slice.gw.owner.execute(
      sql`update auth.session set created_at = now() - interval '1 hour' where user_id = (select id from auth.user where email = 'aisha@example.com')`,
    );
    const stale = await admin.post(`/v1/admin/migrations/${checkedJobId}/dry-run`, {});
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    // Reading still works without a fresh sign-in.
    expect((await admin.get(`/v1/admin/migrations/${checkedJobId}`)).status).toBe(200);
  });
});

describe('export (M02)', () => {
  it('exports the brand’s history as a package in the import format', async () => {
    const requested = await shop.owner.post('/v1/admin/migrations/exports', {
      brandId: shop.brand.id,
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    expect(requested.body).toMatchObject({ kind: 'export', state: 'queued' });
    const done = await settle(requested.body.id, 'completed', 'failed');
    expect(done).toMatchObject({ state: 'completed', packageAvailable: true });

    const download = await shop.owner.get(`/v1/admin/migrations/${requested.body.id}/package`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(String(download.headers['content-disposition'])).toMatch(
      /^attachment; filename="hamnivo-export-/,
    );
    const [file] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.migrationFiles)
        .where(eq(schema.migrationFiles.jobId, fromPublicId('migration', requested.body.id))),
    );
    const bytes = file?.raw as Buffer;
    const { parsed, detected } = readExport(bytes, 'export.zip', 'hamnivo');
    expect(detected).toBeNull();
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const { total } = await importer.listConversations({ page: 1 });
    expect(parsed.conversations).toHaveLength(total);
    // Imported history keeps its original times, and private notes stay private.
    const note = parsed.conversations
      .flatMap((c) => c.messages)
      .find((m) => m.text?.includes('approve a replacement'));
    expect(note).toMatchObject({
      visibility: 'internal',
      createdAt: '2026-08-01T09:02:00.000Z',
    });

    // The package imports again: its preflight reads it without errors.
    const again = await upload(shop.owner, shop.brand.id, 'hamnivo', 'export.zip', bytes);
    const checked = await settle(again.id, 'ready', 'blocked');
    expect(checked.preflight.counts.conversations).toBe(total);
    expect(
      checked.preflight.issues.filter((i: { severity: string }) => i.severity === 'error'),
    ).toEqual([]);
    await act(shop.owner, again.id, 'cancel');
  });
});
