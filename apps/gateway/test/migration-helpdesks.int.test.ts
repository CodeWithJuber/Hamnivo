import { readdirSync, readFileSync } from 'node:fs';
import { writeZip } from '@hamnivo/migration-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, chatwootOf, dueNow, itemsOf, job, tawkZip, upload } from './migration-helpers.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Imports from Zendesk and Intercom exports (M05), with the SDK's fixtures: a Zendesk full JSON
 * export (tickets, the users export, the error file for a ticket over 1 MB, organizations) and
 * Intercom conversations as its API returns them (one cut short at the API's part limit, one
 * without its parts).
 */

const FIXTURES = new URL('../../../packages/migration-sdk/test/fixtures/', import.meta.url);

function fixtureZip(dir: 'zendesk' | 'intercom', rewrite?: (text: string) => string) {
  const folder = new URL(`${dir}/`, FIXTURES);
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(folder).sort()) {
    const bytes = readFileSync(new URL(name, folder));
    // Zendesk names its NDJSON files .json (the fixtures are .ndjson for the formatter's sake).
    const exported = dir === 'zendesk' ? name.replace(/\.ndjson$/, '.json') : name;
    files.set(exported, rewrite ? Buffer.from(rewrite(bytes.toString('utf8'))) : bytes);
  }
  return writeZip(files);
}

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;

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

async function importAll(id: string) {
  await act(shop.owner, id, 'dry-run');
  const counted = await settle(id, 'dry_run_ready');
  await act(shop.owner, id, 'start');
  return { counted, done: await settle(id, 'completed', 'failed') };
}

const codes = (list: Array<{ code: string }>) => list.map((i) => i.code);

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'helpdesks', { publishAgent: false });
  await slice.drain();
});

afterAll(async () => {
  await slice?.close();
});

describe('Zendesk and Intercom imports (M05)', () => {
  it('lists both as sources you upload an export for, with their known limits', async () => {
    const sources = await shop.owner.get('/v1/admin/migrations/sources');
    const bySystem = Object.fromEntries(
      sources.body.items.map((s: { system: string }) => [s.system, s]),
    );
    expect(bySystem.zendesk).toMatchObject({
      available: true,
      accepts: ['zip', 'json', 'ndjson'],
    });
    expect(codes(bySystem.zendesk.limits)).toEqual(
      expect.arrayContaining(['zendesk_large_tickets', 'zendesk_users_export']),
    );
    expect(bySystem.intercom).toMatchObject({ available: true });
    expect(codes(bySystem.intercom.limits)).toEqual(
      expect.arrayContaining(['intercom_parts_cap', 'intercom_api_format']),
    );
  });

  it('refuses an export that is not from the source chosen', async () => {
    const zendeskAsIntercom = await upload(
      shop.owner,
      shop.brand.id,
      'intercom',
      'zendesk.zip',
      fixtureZip('zendesk'),
    );
    const blocked = await settle(zendeskAsIntercom.id, 'blocked');
    expect(blocked.preflight.detected).toBe('zendesk');
    expect(blocked.preflight.checks).toContainEqual({
      code: 'source_mismatch',
      status: 'blocked',
      detail: 'zendesk',
    });
    const tawkAsZendesk = await upload(shop.owner, shop.brand.id, 'zendesk', 'tawk.zip', tawkZip());
    expect((await settle(tawkAsZendesk.id, 'blocked')).preflight.detected).toBe('tawk.to');
    await act(shop.owner, zendeskAsIntercom.id, 'cancel');
    await act(shop.owner, tawkAsZendesk.id, 'cancel');
  });

  let zendeskId: string;

  it('checks a Zendesk export: tickets cut short by Zendesk are reported, nothing is written', async () => {
    const before = slice.fake.requests.length;
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'zendesk',
      'zendesk-export.zip',
      fixtureZip('zendesk'),
    );
    zendeskId = created.id;
    const checked = await settle(created.id, 'ready', 'blocked');
    expect(checked.state).toBe('ready');
    const { preflight } = checked;
    expect(preflight.source).toEqual({ system: 'zendesk', schemaVersion: null, files: 4 });
    expect(preflight.detected).toBeNull();
    expect(preflight.counts).toEqual({
      contacts: 3,
      conversations: 3,
      messages: 9,
      internalNotes: 1,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(preflight.truncated).toBe(true);
    const truncated = preflight.issues.find((i: { code: string }) => i.code === 'truncated');
    expect(truncated).toMatchObject({
      severity: 'warning',
      count: 1,
      examples: [
        expect.objectContaining({
          kind: 'conversation',
          sourceId: '4103',
          detail: 'comments left out of the export (ticket over 1 MB)',
        }),
      ],
    });
    expect(codes(preflight.issues)).toEqual(
      expect.arrayContaining([
        'unsupported_sender',
        'empty_message',
        'duplicate_in_file',
        'unsupported_type',
      ]),
    );
    expect(
      preflight.fields.find((f: { path: string }) => f.path === 'ticket.comments[].public'),
    ).toMatchObject({ status: 'supported', target: 'message.visibility' });
    // Field names and IDs only: no message text or addresses in the check.
    const text = JSON.stringify(checked);
    expect(text).not.toContain('sara.nguyen@example.com');
    expect(text).not.toContain('replacement');
    // Checking reads Chatwoot's settings; it writes nothing there.
    expect(
      slice.fake.requests.slice(before).filter((r) => !['GET', 'HEAD'].includes(r.method)),
    ).toEqual([]);
  });

  it('imports it quietly: original times, private notes, teammates and customers told apart', async () => {
    const { counted, done } = await importAll(zendeskId);
    expect(counted.dryRun).toMatchObject({
      conversations: { total: 4, ready: 3, needsReview: 1 },
      messages: { ready: 9, needsReview: 2, internal: 1 },
      truncated: true,
    });
    expect(done.state).toBe('completed');
    expect(done.progress.conversations).toMatchObject({ imported: 3, quarantined: 1 });
    const items = await itemsOf(slice, shop.tenantId, zendeskId);
    const ref = (sourceId: string) =>
      Number(items.find((i) => i.kind === 'conversation' && i.sourceId === sourceId)?.targetRef);
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const damaged = (await importer.listMessages(ref('4101'))).filter((m) =>
      m.key?.startsWith('hv1:imp:'),
    );
    expect(
      damaged.map((m) => [
        m.private,
        m.direction,
        Number(m.contentAttributes.external_created_at),
        m.text,
      ]),
    ).toEqual([
      [
        false,
        'incoming',
        Date.parse('2026-09-18T08:14:02Z') / 1000,
        'Hello, my parcel arrived damaged. Photo attached.',
      ],
      [
        true,
        'outgoing',
        Date.parse('2026-09-18T08:40:11Z') / 1000,
        'Checked with the warehouse. @Omar please send a replacement today.',
      ],
      [
        false,
        'outgoing',
        Date.parse('2026-09-18T08:45:30Z') / 1000,
        'Sorry about that, Sara. A replacement is on its way.',
      ],
      [false, 'incoming', Date.parse('2026-09-18T09:02:44Z') / 1000, 'Thank you!'],
    ]);
    expect((await importer.getConversation(ref('4101')))?.status).toBe('resolved');
    expect((await importer.getConversation(ref('4101')))?.attributes).toMatchObject({
      hv_import_source: 'zendesk',
      hv_source_id: '4101',
      hv_subject: 'Parcel arrived damaged',
      hv_labels: 'damaged, refund',
      hv_assignee: 'Liam Davies',
      hv_src_zendesk_satisfaction: 'good',
    });
    // An open ticket stays open; the person copied in keeps her name on her message.
    expect((await importer.getConversation(ref('4102')))?.status).toBe('open');
    const address = (await importer.listMessages(ref('4102'))).filter((m) =>
      m.key?.startsWith('hv1:imp:'),
    );
    const authorOf = (m: (typeof address)[number]) =>
      (m.contentAttributes.hv_import as { author?: unknown } | undefined)?.author;
    expect(address.map((m) => [m.direction, authorOf(m)])).toEqual([
      ['incoming', { kind: 'customer', name: 'عمر حداد' }],
      ['outgoing', { kind: 'agent', name: 'Aisha Karim' }],
      ['incoming', { kind: 'customer', name: 'Nadia Rahman' }],
    ]);
    // Addresses stay notes on the contact, never Chatwoot's email or phone.
    const sara = await importer.getContact(
      Number(items.find((i) => i.kind === 'contact' && i.sourceId === 'user:9001')?.targetRef),
    );
    expect(sara).toMatchObject({ name: 'Sara Nguyen', email: null, phone: null });
    expect(sara?.attributes).toMatchObject({ hv_unverified_email: 'sara.nguyen@example.com' });
    expect(slice.fake.outbound.filter((o) => o.accountId === shop.connection.accountId)).toEqual(
      [],
    );
  });

  it('reconciles every ticket and comment, and needs the cut-short export acknowledged', async () => {
    const done = await job(shop.owner, zendeskId);
    expect(done.report).toMatchObject({
      gate: 'failed',
      kinds: {
        conversation: { discovered: 4, imported: 3, quarantined: 1 },
        message: { discovered: 10, imported: 8, quarantined: 2 },
        note: { discovered: 1, imported: 1 },
        contact: { discovered: 3, imported: 3 },
        attachment: { discovered: 1, quarantined: 1 },
      },
    });
    expect(done.report.checks).toEqual(
      expect.arrayContaining([
        { code: 'all_accounted', ok: true },
        { code: 'export_complete', ok: false },
        { code: 'private_kept_private', ok: true },
        { code: 'nothing_sent', ok: true },
        { code: 'sample_matches', ok: true },
      ]),
    );
    expect(done.report.reasons).toEqual(
      expect.arrayContaining([
        { kind: 'conversation', reason: 'truncated', count: 1 },
        { kind: 'message', reason: 'unsupported_sender', count: 1 },
        { kind: 'attachment', reason: 'binary_not_in_export', count: 1 },
      ]),
    );
    const problems = await shop.owner.get(
      `/v1/admin/migrations/${zendeskId}/items?status=problems`,
    );
    expect(
      problems.body.items.find((i: { sourceId: string }) => i.sourceId === '4103'),
    ).toMatchObject({ kind: 'conversation', status: 'quarantined', reason: 'truncated' });
    const refused = await shop.owner.post(`/v1/admin/migrations/${zendeskId}/cutover`, {});
    expect(refused.status).toBe(422);
    const closed = await act(shop.owner, zendeskId, 'cutover', { acknowledgeFailedChecks: true });
    expect(closed.state).toBe('closed');
  });

  it('skips tickets already imported, but not the same ticket numbers of another Zendesk account', async () => {
    const again = await upload(
      shop.owner,
      shop.brand.id,
      'zendesk',
      'zendesk-again.zip',
      fixtureZip('zendesk'),
    );
    await settle(again.id, 'ready');
    await act(shop.owner, again.id, 'dry-run');
    const repeated = await settle(again.id, 'dry_run_ready');
    expect(repeated.dryRun.conversations).toMatchObject({ ready: 0, duplicates: 3 });
    await act(shop.owner, again.id, 'cancel');

    const other = await upload(
      shop.owner,
      shop.brand.id,
      'zendesk',
      'southgate.zip',
      fixtureZip('zendesk', (text) =>
        text.replaceAll('northline.zendesk.com', 'southgate.zendesk.com'),
      ),
    );
    await settle(other.id, 'ready');
    await act(shop.owner, other.id, 'dry-run');
    const fresh = await settle(other.id, 'dry_run_ready');
    expect(fresh.dryRun.conversations).toMatchObject({ ready: 3, duplicates: 0 });
    await act(shop.owner, other.id, 'cancel');
  });

  it('imports Intercom conversations as plain text, with cut-short ones reported', async () => {
    const created = await upload(
      shop.owner,
      shop.brand.id,
      'intercom',
      'intercom.zip',
      fixtureZip('intercom'),
    );
    const checked = await settle(created.id, 'ready', 'blocked');
    expect(checked.state).toBe('ready');
    expect(checked.preflight.counts).toEqual({
      contacts: 2,
      conversations: 3,
      messages: 10,
      internalNotes: 1,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(
      checked.preflight.issues.find((i: { code: string }) => i.code === 'truncated'),
    ).toMatchObject({ count: 2 });
    const { done } = await importAll(created.id);
    expect(done.progress.conversations).toMatchObject({ imported: 3, quarantined: 1 });
    expect(done.report.checks).toEqual(
      expect.arrayContaining([
        { code: 'export_complete', ok: false },
        { code: 'private_kept_private', ok: true },
        { code: 'sample_matches', ok: true },
      ]),
    );
    const items = await itemsOf(slice, shop.tenantId, created.id);
    const target = Number(
      items.find((i) => i.kind === 'conversation' && i.sourceId === '215468201')?.targetRef,
    );
    const { importer } = await chatwootOf(slice, shop.tenantId, shop.connection.id);
    const messages = (await importer.listMessages(target)).filter((m) =>
      m.key?.startsWith('hv1:imp:'),
    );
    expect(messages.map((m) => [m.private, m.direction, m.text])).toEqual([
      [false, 'incoming', 'Hi, my order 4821 arrived damaged.\nReceipt attached & photos soon.'],
      [true, 'outgoing', 'Courier confirmed the damage. Tracking (https://tracking.example/4821)'],
      [
        false,
        'outgoing',
        'Sorry, Sara! A replacement ships today.\n\n- Order 4821\n- Arrives Friday',
      ],
      [false, 'incoming', 'Thanks 🙏'],
    ]);
    expect((await importer.getConversation(target))?.status).toBe('resolved');
    expect(slice.fake.outbound.filter((o) => o.accountId === shop.connection.accountId)).toEqual(
      [],
    );
  });
});
