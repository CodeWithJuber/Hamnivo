import { describe, expect, it } from 'vitest';
import {
  dryRun,
  PackageError,
  parseTawkExport,
  planItems,
  preflight,
  readExport,
  TAWK_EXPORT_CAP,
  tawkDescriptor,
} from '../src/index.js';
import { json, tawkChat, tawkFiles, tawkZip, thrown, zip } from './helpers.js';

const SARA = '1f0c6f40-9b3e-11ef-8d6a-2b7c9e4f5a10';
const OMAR = '3a91d2c0-9c12-11ef-a1b4-6f2d8e0c7b33';
const AYESHA = '5d77e1b0-9d40-11ef-b9c2-0e4a6c1d2f88';
const SARA_AGAIN = '7b2e40a0-9e55-11ef-8c31-4d9a2e7f1c05';

describe('tawk.to export', () => {
  const { parsed, detected } = readExport(tawkZip(), 'tawk-export.zip', 'tawk.to');

  it('reads every chat in the ZIP into conversations, contacts and messages', () => {
    expect(detected).toBeNull();
    expect(parsed.system).toBe('tawk.to');
    expect(parsed.files).toBe(4);
    expect(parsed.origin).toEqual({ system: 'tawk.to', account: null });
    expect(parsed.conversations.map((c) => c.record.id).sort()).toEqual(
      [SARA, OMAR, AYESHA, SARA_AGAIN].sort(),
    );
    // The same visitor ID in two chats is one person; nobody is matched by email.
    expect(parsed.contacts).toHaveLength(3);
    const sara = parsed.conversations.filter((c) => [SARA, SARA_AGAIN].includes(c.record.id));
    expect(new Set(sara.map((c) => c.record.contactId)).size).toBe(1);
    expect(parsed.conversations.flatMap((c) => c.messages)).toHaveLength(11);
  });

  it('keeps original times, authors and order, sorted by time', () => {
    const chat = parsed.conversations.find((c) => c.record.id === SARA);
    expect(chat?.record).toMatchObject({
      status: 'resolved',
      startedAt: '2026-09-20T09:12:04.118Z',
      declaredMessageCount: 4,
      assignee: { name: 'Liam Davies', sourceId: '18f66404b4817a529e67a171' },
      attributes: {
        tawk_rating: 1,
        tawk_chat_duration: 342,
        tawk_page_id: '6512f0c4a9e3b10c8d7e4f21',
      },
    });
    expect(
      chat?.messages.map((m) => [m.id, m.createdAt, m.author.kind, m.author.name, m.visibility]),
    ).toEqual([
      [`${SARA}:0`, '2026-09-20T09:12:04.118Z', 'system', null, 'public'],
      [`${SARA}:1`, '2026-09-20T09:12:31.502Z', 'customer', 'Sara Nguyen', 'public'],
      // Exported after the agent's reply but sent before it.
      [`${SARA}:3`, '2026-09-20T09:17:46.880Z', 'customer', 'Sara Nguyen', 'public'],
      [`${SARA}:2`, '2026-09-20T09:24:10.004Z', 'agent', 'Liam Davies', 'public'],
    ]);
    const arabic = parsed.conversations.find((c) => c.record.id === OMAR);
    expect(arabic?.messages[0]?.text).toBe('مرحبًا، هل يمكنني تغيير عنوان التوصيل لطلبي رقم 4821؟');
    expect(arabic?.messages[2]?.text).toBe('شكرًا جزيلًا 🙏');
  });

  it('keeps typed-in emails as unverified only, with a reference to the raw export', () => {
    const sara = parsed.contacts.find((c) => c.name === 'Sara Nguyen');
    expect(sara).toMatchObject({
      verified: null,
      unverified: { email: 'sara.nguyen@example.com' },
      location: { city: 'Leeds', countryCode: 'GB' },
      source: { system: 'tawk.to', raw: { pointer: '/visitor' } },
    });
    const anonymous = parsed.contacts.find((c) => c.name === 'V1727190442218704');
    expect(anonymous?.unverified).toEqual({});
  });

  it('lists linked files as attachments whose file is not in the export', () => {
    const attachment = parsed.attachments.get(`${SARA}:1:0`);
    expect(attachment).toMatchObject({
      bytes: null,
      problem: 'binary_not_in_export',
      entry: {
        messageId: `${SARA}:1`,
        name: 'order-receipt.pdf',
        mediaType: 'application/pdf',
        size: 245760,
        url: 'https://tawk.link/6512f0c4a9e3b10c8d7e4f21/files/message/Xk2mQ9pL/order-receipt.pdf',
      },
    });
  });

  it('reports a chat with fewer messages than declared, and each message it cannot import', () => {
    expect(parsed.truncated).toBe(true);
    const codes = parsed.issues.map((i) => [i.code, i.sourceId ?? null]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['truncated', AYESHA],
        ['missing_time', `${AYESHA}:2`],
        ['unsupported_type', `${AYESHA}:3`],
        ['empty_message', `${AYESHA}:4`],
        ['unsupported_type', '9c05f7e0-9f01-11ef-a6d8-1b3c5e7a9d20'],
      ]),
    );
    // Issues name objects and places in the export, never message text.
    for (const issue of parsed.issues) {
      expect(JSON.stringify(issue)).not.toMatch(/tracking|Missed call/);
    }
  });

  it('builds the preflight report: counts, fields, known limits and issues', () => {
    const report = preflight(parsed, tawkDescriptor);
    expect(report.counts).toEqual({
      contacts: 3,
      conversations: 4,
      messages: 11,
      internalNotes: 0,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(report.declared).toEqual({ conversations: 4, messages: 15 });
    expect(report.blocking).toBe(false);
    expect(report.missingRequired).toEqual([]);
    expect(report.limits.map((l) => l.code)).toContain('tawk_export_cap');
    const field = (path: string) => report.fields.find((f) => f.path === path);
    expect(field('visitor.email')).toMatchObject({ status: 'transformed', count: 3 });
    expect(field('messages[].msg')).toMatchObject({ status: 'supported', types: ['string'] });
    expect(field('messages[].attchs[].content.file.url')).toMatchObject({ status: 'transformed' });
    expect(report.issues.find((i) => i.code === 'truncated')).toMatchObject({ count: 1 });
  });

  it('shows fields it does not import instead of dropping them', () => {
    const files = new Map([
      ['a.json', json(tawkChat('a', { tags: ['vip'], department: 'Sales' }))],
    ]);
    const report = preflight(parseTawkExport(files), tawkDescriptor);
    expect(report.fields.filter((f) => f.status === 'unsupported').map((f) => f.path)).toEqual([
      'department',
      'tags[]',
    ]);
  });

  it('marks required fields as missing when no message has a time (mapping incomplete)', () => {
    const chat = tawkChat('b', {
      createdOn: '2026-09-01T10:00:00.000Z',
      messages: [{ sender: { t: 'v' }, type: 'msg', msg: 'no time' }],
    });
    const report = preflight(parseTawkExport(new Map([['b.json', json(chat)]])), tawkDescriptor);
    expect(report.missingRequired).toEqual(['messages[].time']);
    expect(report.blocking).toBe(true);
  });

  it('warns when the export holds exactly as many chats as tawk.to exports at once', () => {
    const files = new Map(
      Array.from({ length: TAWK_EXPORT_CAP }, (_, i) => [`c${i}.json`, json(tawkChat(`c${i}`))]),
    );
    const parsed = parseTawkExport(files);
    expect(parsed.issues.map((i) => i.code)).toContain('export_cap_reached');
  });

  it('reports a JSON file cut short as truncated', () => {
    const files = tawkFiles();
    const [name, bytes] = [...files.entries()][0] as [string, Uint8Array];
    files.set(name, bytes.slice(0, Math.floor(bytes.length / 2)));
    const parsed = parseTawkExport(files);
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: 'truncated_file', severity: 'error', location: name }),
    );
  });

  it('refuses an archive that ends early', () => {
    const bytes = tawkZip();
    const error = thrown(() => readExport(bytes.slice(0, bytes.length - 30), 'x.zip', 'tawk.to'));
    expect(error).toBeInstanceOf(PackageError);
    expect(error).toMatchObject({ code: 'truncated' });
  });

  it('refuses files that are not exports', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(thrown(() => readExport(png, 'x.png', 'tawk.to'))).toMatchObject({
      code: 'not_supported',
    });
  });

  it('plans one item per object: duplicates from earlier imports skipped, problems quarantined', () => {
    const items = planItems(parsed, { conversations: new Set([OMAR]) });
    const of = (kind: string, sourceId: string) =>
      items.find((i) => i.kind === kind && i.sourceId === sourceId);
    expect(of('conversation', OMAR)).toMatchObject({
      status: 'skipped',
      reason: 'duplicate_existing',
    });
    expect(of('message', `${OMAR}:0`)).toMatchObject({ status: 'skipped' });
    expect(of('conversation', SARA)).toMatchObject({ status: 'pending', reason: null });
    expect(of('message', `${AYESHA}:3`)).toMatchObject({
      status: 'quarantined',
      reason: 'unsupported_type',
      conversationSourceId: AYESHA,
    });
    expect(of('attachment', `${SARA}:1:0`)).toMatchObject({
      status: 'quarantined',
      reason: 'binary_not_in_export',
    });
    // The Arabic-speaking visitor's only chat was imported before: no new contact.
    expect(items.filter((i) => i.kind === 'contact' && i.status === 'pending')).toHaveLength(2);
    const keys = items.map((i) => `${i.kind}:${i.sourceId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('counts a dry run without writing anything', () => {
    const result = dryRun(parsed, { conversations: new Set([OMAR]) });
    expect(result.conversations).toEqual({ total: 5, ready: 3, duplicates: 1, needsReview: 1 });
    expect(result.messages).toMatchObject({ ready: 8, duplicates: 3, needsReview: 3, internal: 0 });
    expect(result.identity).toEqual({ verified: 0, unverified: 2 });
    expect(result.truncated).toBe(true);
    expect(result.samples).toHaveLength(3);
  });

  it('builds the export fixture into a ZIP a person would download', () => {
    expect(zip(tawkFiles()).length).toBeGreaterThan(1000);
  });
});
