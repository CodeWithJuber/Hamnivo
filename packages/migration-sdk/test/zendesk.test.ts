import { describe, expect, it } from 'vitest';
import {
  parseZendeskExport,
  planItems,
  preflight,
  readExport,
  zendeskDescriptor,
} from '../src/index.js';
import { json, ndjson, zendeskFiles, zip } from './helpers.js';

const TICKETS = 'export/export-2026-09-20-0930-5512-7f3e2a91c04d.json';

describe('Zendesk full JSON export', () => {
  const { parsed, detected } = readExport(zip(zendeskFiles()), 'zendesk-export.zip', 'zendesk');
  const ticket = (id: string) => parsed.conversations.find((c) => c.record.id === id);

  it('reads the tickets with their comments, and the users export for names and roles', () => {
    expect(detected).toBeNull();
    expect(parsed.system).toBe('zendesk');
    expect(parsed.files).toBe(4);
    // IDs are unique within one Zendesk account, named by the subdomain in the ticket URLs.
    expect(parsed.origin).toEqual({ system: 'zendesk', account: 'northline' });
    expect(parsed.conversations.map((c) => c.record.id)).toEqual(['4101', '4102', '4104']);
    // Only requesters of imported tickets become people; teammates and others do not.
    expect(parsed.contacts.map((c) => [c.id, c.name])).toEqual([
      ['user:9001', 'Sara Nguyen'],
      ['user:9002', 'عمر حداد'],
      ['user:9003', null],
    ]);
    expect(ticket('4101')?.record).toMatchObject({
      contactId: 'user:9001',
      status: 'resolved',
      startedAt: '2026-09-18T08:14:02.000Z',
      subject: 'Parcel arrived damaged',
      channel: 'zendesk email',
      labels: ['damaged', 'refund'],
      assignee: { name: 'Liam Davies', sourceId: '7001' },
      declaredMessageCount: null,
      attributes: {
        zendesk_priority: 'normal',
        zendesk_type: 'incident',
        zendesk_satisfaction: 'good',
      },
      source: { system: 'zendesk', id: '4101', raw: { file: TICKETS, pointer: '/0/ticket' } },
    });
    expect(ticket('4102')?.record).toMatchObject({ status: 'open', assignee: null });
    expect(ticket('4104')?.record.status).toBe('pending');
  });

  it('keeps original times, authors and privacy, sorted by time', () => {
    expect(
      ticket('4101')?.messages.map((m) => [
        m.id,
        m.createdAt,
        m.author.kind,
        m.author.name,
        m.visibility,
      ]),
    ).toEqual([
      ['4101:50001', '2026-09-18T08:14:02.000Z', 'customer', 'Sara Nguyen', 'public'],
      ['4101:50002', '2026-09-18T08:40:11.000Z', 'agent', 'Liam Davies', 'internal'],
      // Exported before the reply but written after it.
      ['4101:50003', '2026-09-18T08:45:30.000Z', 'agent', 'Liam Davies', 'public'],
      ['4101:50005', '2026-09-18T09:02:44.000Z', 'customer', 'Sara Nguyen', 'public'],
    ]);
    const arabic = ticket('4102')?.messages ?? [];
    expect(arabic[0]?.text).toBe('مرحبًا، هل يمكنني تغيير عنوان التوصيل لطلبي رقم 4822؟');
    // An admin who is not the assignee is a teammate; a person copied in is a customer.
    expect(arabic.map((m) => [m.author.kind, m.author.name])).toEqual([
      ['customer', 'عمر حداد'],
      ['agent', 'Aisha Karim'],
      ['customer', 'Nadia Rahman'],
    ]);
    expect(ticket('4101')?.messages[0]?.source).toEqual({
      system: 'zendesk',
      id: '50001',
      raw: { file: TICKETS, pointer: '/0/ticket/comments/0' },
    });
  });

  it('reports tickets whose comments Zendesk left out as cut short, and does not import them', () => {
    expect(parsed.truncated).toBe(true);
    expect(parsed.issues).toContainEqual({
      severity: 'warning',
      code: 'truncated',
      kind: 'conversation',
      sourceId: '4103',
      location: `${TICKETS}:4#/ticket`,
      detail: 'comments left out of the export (ticket over 1 MB)',
    });
    const items = planItems(parsed);
    expect(items.find((i) => i.kind === 'conversation' && i.sourceId === '4103')).toMatchObject({
      status: 'quarantined',
      reason: 'truncated',
    });
    const report = preflight(parsed, zendeskDescriptor);
    expect(report.truncated).toBe(true);
    expect(report.blocking).toBe(false);
    expect(report.counts).toEqual({
      contacts: 3,
      conversations: 3,
      messages: 9,
      internalNotes: 1,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(report.missingRequired).toEqual([]);
    expect(report.limits.map((l) => l.code)).toEqual([
      'zendesk_large_tickets',
      'zendesk_users_export',
      'zendesk_attachment_links',
      'zendesk_history',
      'zendesk_unverified_contacts',
    ]);
  });

  it('lists what it cannot import with a reason: unknown authors, empty comments, repeats', () => {
    const codes = parsed.issues.map((i) => [i.code, i.sourceId ?? i.detail]);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['duplicate_in_file', '4102'],
        ['unsupported_sender', '4104:52002'],
        ['empty_message', '4104:52004'],
        ['unsupported_type', 'organization'],
      ]),
    );
    expect(parsed.issues.find((i) => i.sourceId === '4104:52002')?.detail).toBe(
      'author not in the users export',
    );
    // Liam is known as a teammate from the users export; Tom is not guessed at.
    expect(ticket('4104')?.messages.map((m) => [m.id, m.author.kind])).toEqual([
      ['4104:52001', 'customer'],
      ['4104:52003', 'agent'],
    ]);
  });

  it('keeps addresses as not verified only, and files as links', () => {
    expect(parsed.contacts.find((c) => c.id === 'user:9001')).toMatchObject({
      verified: null,
      unverified: { email: 'sara.nguyen@example.com', phone: '+44 7700 900123' },
      source: { system: 'zendesk', id: '9001' },
    });
    expect(parsed.attachments.get('4101:50001:31001')).toMatchObject({
      bytes: null,
      problem: 'binary_not_in_export',
      entry: {
        messageId: '4101:50001',
        name: 'damaged-box.jpg',
        mediaType: 'image/jpeg',
        size: 48213,
        path: null,
        url: 'https://northline.zendesk.com/attachments/token/Zx81kq2/?name=damaged-box.jpg',
      },
    });
    // The schema sample names fields only, never values.
    expect(JSON.stringify(parsed.fields)).not.toContain('sara.nguyen@example.com');
    expect(parsed.fields.find((f) => f.path === 'ticket.comments[].html_body')).toMatchObject({
      status: 'unsupported',
      target: 'message.formatting',
    });
    expect(
      parsed.fields.find((f) => f.path === 'ticket.comments[].metadata.system.ip_address')?.status,
    ).toBe('unsupported');
  });

  it('without the users export, knows teammates from assignments and notes and guesses no one', () => {
    const alone = parseZendeskExport(zendeskFiles(['users-']));
    const messages = alone.conversations.flatMap((c) => c.messages);
    const kinds = Object.fromEntries(messages.map((m) => [m.id, m.author.kind]));
    expect(kinds).toMatchObject({
      '4101:50001': 'customer',
      '4101:50002': 'agent',
      '4101:50003': 'agent',
      '4102:51001': 'customer',
      '4104:52003': 'agent',
    });
    // Aisha and Nadia can't be told apart from the export alone.
    expect(
      alone.issues.filter((i) => i.code === 'unsupported_sender').map((i) => i.sourceId),
    ).toEqual(['4102:51002', '4102:51003', '4104:52002']);
    // An emailed ticket still names its requester, as not verified.
    expect(alone.contacts.find((c) => c.id === 'user:9001')).toMatchObject({
      name: 'Sara Nguyen',
      unverified: { email: 'sara.nguyen@example.com' },
    });
    expect(alone.contacts.find((c) => c.id === 'user:9002')?.name).toBeNull();
  });

  it('reads bare tickets, API responses and plain JSON as well as the wrapped lines', () => {
    const base = {
      id: 1,
      requester_id: 10,
      status: 'closed',
      created_at: '2026-01-02T03:04:05Z',
      comments: [
        { id: 7, author_id: 10, body: 'Hi', public: true, created_at: '2026-01-02T03:04:05Z' },
        { id: 8, author_id: -1, body: 'Closed by a trigger', created_at: '2026-01-03T00:00:00Z' },
      ],
    };
    const bare = parseZendeskExport(new Map([['tickets.ndjson', ndjson([base])]]));
    expect(bare.conversations.map((c) => c.record.id)).toEqual(['1']);
    expect(bare.conversations[0]?.messages.map((m) => m.author.kind)).toEqual([
      'customer',
      'system',
    ]);
    const api = parseZendeskExport(
      new Map([
        [
          'tickets.json',
          json({
            tickets: [base, { ...base, id: 2 }],
            users: [{ id: 10, name: 'Mina', role: 'end-user' }],
          }),
        ],
      ]),
    );
    expect(api.conversations.map((c) => c.record.id)).toEqual(['1', '2']);
    expect(api.contacts[0]?.name).toBe('Mina');
    expect(api.issues.find((i) => i.code === 'duplicate_in_file')).toBeUndefined();
    const array = parseZendeskExport(new Map([['tickets.json', json([{ ticket: base }])]]));
    expect(array.conversations).toHaveLength(1);
    expect(array.conversations[0]?.record.source.raw).toEqual({
      file: 'tickets.json',
      pointer: '/0/ticket',
    });
  });

  it('reports lines that are cut off or unreadable, and deleted tickets', () => {
    const good = JSON.stringify({
      ticket: {
        id: 5,
        requester_id: 1,
        created_at: '2026-01-02T03:04:05Z',
        comments: [{ id: 1, author_id: 1, body: 'Hi', created_at: '2026-01-02T03:04:05Z' }],
      },
    });
    const deleted = JSON.stringify({
      ticket: { id: 6, requester_id: 1, status: 'deleted', comments: [] },
    });
    const text = `not json\n${good}\n${deleted}\n{"ticket":{"id":7,"requester_`;
    const parsedText = parseZendeskExport(
      new Map([['export.json', new TextEncoder().encode(text)]]),
    );
    expect(parsedText.conversations.map((c) => c.record.id)).toEqual(['5']);
    expect(parsedText.truncated).toBe(true);
    expect(parsedText.issues.map((i) => [i.code, i.location])).toEqual(
      expect.arrayContaining([
        // A damaged first line doesn't hide the lines after it.
        ['invalid_json', 'export.json:1'],
        ['truncated_file', 'export.json:4'],
        ['unsupported_type', 'export.json:3#/ticket'],
      ]),
    );
  });

  it('reports an export error that names no ticket, and an export without comments', () => {
    const errorOnly = parseZendeskExport(
      new Map([
        [
          'export.json',
          ndjson([
            { ticket: { id: 9, requester_id: 1, created_at: '2026-01-02T03:04:05Z' } },
            { error: 'ExportFailed' },
          ]),
        ],
      ]),
    );
    expect(errorOnly.truncated).toBe(true);
    expect(errorOnly.issues.map((i) => [i.code, i.sourceId ?? null, i.detail])).toEqual([
      ['truncated', null, 'the export reports an error'],
      ['truncated', '9', 'no comments in the export'],
      ['no_conversations', null, undefined],
    ]);
    expect(preflight(errorOnly, zendeskDescriptor).blocking).toBe(true);
  });

  it('does not import a ticket the error file lists, even when some comments came through', () => {
    const partial = parseZendeskExport(
      new Map([
        [
          'export.json',
          ndjson([
            {
              ticket: {
                id: 12,
                requester_id: 1,
                created_at: '2026-01-02T03:04:05Z',
                comments: [{ id: 1, author_id: 1, body: 'Hi', created_at: '2026-01-02T03:04:05Z' }],
              },
            },
          ]),
        ],
        ['errors.json', ndjson([{ ticket_id: 12, error: 'TicketTooLarge' }])],
      ]),
    );
    expect(partial.conversations).toEqual([]);
    expect(planItems(partial).find((i) => i.sourceId === '12')).toMatchObject({
      status: 'quarantined',
      reason: 'truncated',
    });
  });

  it('leaves out a comment longer than Chatwoot takes, with the reason', () => {
    const long = parseZendeskExport(
      new Map([
        [
          'export.json',
          ndjson([
            {
              ticket: {
                id: 3,
                requester_id: 1,
                created_at: '2026-01-02T03:04:05Z',
                comments: [
                  { id: 1, author_id: 1, body: 'Hi', created_at: '2026-01-02T03:04:05Z' },
                  {
                    id: 2,
                    author_id: 1,
                    body: 'x'.repeat(150_001),
                    created_at: '2026-01-02T03:05:00Z',
                  },
                ],
              },
            },
          ]),
        ],
      ]),
    );
    expect(long.conversations[0]?.messages.map((m) => m.id)).toEqual(['3:1']);
    expect(planItems(long).find((i) => i.sourceId === '3:2')).toMatchObject({
      kind: 'message',
      status: 'quarantined',
      reason: 'too_large',
    });
  });

  it('is told apart from other exports by its content', () => {
    const wrong = readExport(zip(zendeskFiles()), 'zendesk-export.zip', 'tawk.to');
    expect(wrong.detected).toBe('zendesk');
  });
});
