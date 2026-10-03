import { describe, expect, it } from 'vitest';
import {
  detectSystem,
  htmlToText,
  intercomDescriptor,
  parseIntercomExport,
  planItems,
  preflight,
  readExport,
} from '../src/index.js';
import {
  fixtureFiles,
  INTERCOM_DIR,
  json,
  ndjson,
  tawkFiles,
  zendeskFiles,
  zip,
} from './helpers.js';

const SARA = '6512f0c4a9e3b10c8d7e4f21';
const BILAL = '6512f0c4a9e3b10c8d7e4f99';
const LIST = 'export/conversations-2025-09.json';

describe('Intercom conversations (API format)', () => {
  const { parsed, detected } = readExport(
    zip(fixtureFiles(INTERCOM_DIR)),
    'intercom.zip',
    'intercom',
  );
  const conversation = (id: string) => parsed.conversations.find((c) => c.record.id === id);

  it('reads conversation lists, NDJSON lines and contacts', () => {
    expect(detected).toBeNull();
    expect(parsed.system).toBe('intercom');
    expect(parsed.files).toBe(3);
    expect(parsed.origin).toEqual({ system: 'intercom', account: null });
    expect(parsed.conversations.map((c) => c.record.id)).toEqual([
      '215468201',
      '215468202',
      '215468204',
    ]);
    // The contact object gives Sara's details; Bilal is named by his own messages.
    expect(parsed.contacts).toEqual([
      expect.objectContaining({
        id: `contact:${SARA}`,
        name: 'Sara Nguyen',
        verified: null,
        unverified: { email: 'sara.nguyen@example.com', phone: '+44 7700 900123' },
        location: { city: 'Leeds' },
      }),
      expect.objectContaining({
        id: `contact:${BILAL}`,
        name: 'بلال أحمد',
        unverified: { email: 'bilal@example.com' },
      }),
    ]);
  });

  it('keeps times, authors and privacy, and turns HTML into plain text', () => {
    const first = conversation('215468201');
    expect(first?.record).toMatchObject({
      contactId: `contact:${SARA}`,
      status: 'resolved',
      startedAt: '2025-09-18T09:14:02.000Z',
      subject: 'Damaged parcel',
      channel: 'intercom conversation',
      labels: ['damaged', 'vip'],
      assignee: { name: 'Liam Davies', sourceId: '5017691' },
      source: { raw: { file: LIST, pointer: '/conversations/0' } },
    });
    // Flat values only: the nested custom attribute is not copied.
    expect(first?.record.attributes).toEqual({
      intercom_priority: 'not_priority',
      intercom_rating: 5,
      intercom_order: '4821',
      intercom_refund: false,
    });
    // Events without text (assignment, close) are not messages.
    expect(
      first?.messages.map((m) => [m.id, m.createdAt, m.author.kind, m.visibility, m.text]),
    ).toEqual([
      [
        '215468201:source',
        '2025-09-18T09:14:02.000Z',
        'customer',
        'public',
        'Hi, my order 4821 arrived damaged.\nReceipt attached & photos soon.',
      ],
      [
        '215468201:11002',
        '2025-09-18T09:16:02.000Z',
        'agent',
        'internal',
        'Courier confirmed the damage. Tracking (https://tracking.example/4821)',
      ],
      [
        '215468201:11003',
        '2025-09-18T09:17:02.000Z',
        'agent',
        'public',
        'Sorry, Sara! A replacement ships today.\n\n- Order 4821\n- Arrives Friday',
      ],
      ['215468201:11004', '2025-09-18T09:18:02.000Z', 'customer', 'public', 'Thanks 🙏'],
    ]);
    const bot = conversation('215468204');
    expect(bot?.record.status).toBe('snoozed');
    expect(bot?.messages.map((m) => [m.author.kind, m.author.name, m.text])).toEqual([
      ['customer', 'Sara Nguyen', 'Where is my refund?'],
      ['bot', 'Fin', 'Refunds take 3–5 days. Anything else?'],
      ['customer', 'Sara Nguyen', 'No, thanks.'],
    ]);
  });

  it('reports conversations the API cut short, and does not import one without its parts', () => {
    expect(parsed.truncated).toBe(true);
    const long = conversation('215468202');
    expect(long?.record.status).toBe('open');
    expect(long?.messages.map((m) => m.text)).toEqual([
      'مرحبًا، أريد طلب 300 قطعة.',
      'نعم، يمكننا ذلك.',
      'شكرًا',
    ]);
    expect(parsed.issues).toContainEqual({
      severity: 'warning',
      code: 'truncated',
      kind: 'conversation',
      sourceId: '215468202',
      location: `${LIST}#/conversations/1`,
      detail: '3 of 503 parts in the export',
    });
    const items = planItems(parsed);
    // Imported with what is there…
    expect(items.find((i) => i.sourceId === '215468202')).toMatchObject({ status: 'pending' });
    // …but a conversation without any parts is left out, with the reason.
    expect(items.find((i) => i.sourceId === '215468203')).toMatchObject({
      kind: 'conversation',
      status: 'quarantined',
      reason: 'truncated',
    });
    expect(items.find((i) => i.sourceId === '215468202:12499')).toMatchObject({
      status: 'quarantined',
      reason: 'empty_message',
    });
    expect(items.find((i) => i.sourceId === '215468204:14002')).toMatchObject({
      status: 'quarantined',
      reason: 'unsupported_type',
    });
    // Events (an assignment, closing, snoozing) are neither messages nor records to review.
    for (const event of ['215468201:11001', '215468201:11005', '215468204:14004']) {
      expect(items.find((i) => i.sourceId === event)).toBeUndefined();
      expect(parsed.issues.find((i) => i.sourceId === event)).toBeUndefined();
    }
    const report = preflight(parsed, intercomDescriptor);
    expect(report.counts).toEqual({
      contacts: 2,
      conversations: 3,
      messages: 10,
      internalNotes: 1,
      attachments: 1,
      attachmentFiles: 0,
    });
    expect(report.blocking).toBe(false);
    expect(report.limits.map((l) => l.code)).toContain('intercom_parts_cap');
    expect(parsed.attachments.get('215468201:source:0')).toMatchObject({
      bytes: null,
      problem: 'binary_not_in_export',
      entry: { name: 'receipt.pdf', mediaType: 'application/pdf', size: 20391 },
    });
    expect(parsed.fields.find((f) => f.path === 'custom_attributes.details.nested')?.status).toBe(
      'unsupported',
    );
  });

  it('keeps replies sent with an action, and leaves out unknown senders', () => {
    const at = 1758186842;
    const parsedOne = parseIntercomExport(
      new Map([
        [
          'one.ndjson',
          ndjson([
            {
              type: 'conversation',
              id: '9',
              created_at: at,
              state: 'closed',
              source: { type: 'email', body: 'Hello', author: { type: 'user', id: 'u1' } },
              conversation_parts: {
                total_count: 2,
                conversation_parts: [
                  {
                    id: 'p1',
                    part_type: 'close',
                    body: '<p>Done, closing.</p>',
                    created_at: at + 5,
                    author: { type: 'admin', id: 'a1', name: 'Kim' },
                  },
                  {
                    id: 'p2',
                    part_type: 'comment',
                    body: '<p>?</p>',
                    created_at: `${at + 9}`,
                    author: { type: 'visitor', id: 'x' },
                  },
                ],
              },
            },
          ]),
        ],
      ]),
    );
    expect(parsedOne.conversations[0]?.messages.map((m) => [m.id, m.sourceType])).toEqual([
      ['9:source', 'source'],
      ['9:p1', 'close'],
    ]);
    expect(parsedOne.issues.map((i) => [i.code, i.sourceId, i.detail])).toEqual([
      ['unsupported_sender', '9:p2', 'sender visitor'],
    ]);
    // Without a contact list, the customer who started it is the contact.
    expect(parsedOne.conversations[0]?.record.contactId).toBe('contact:u1');
  });

  it('reports unreadable files and lines', () => {
    const broken = parseIntercomExport(
      new Map([
        ['a.json', new TextEncoder().encode('{"type":"conversation","id":"1",')],
        ['b.json', json({ hello: 'world' })],
        ['notes.txt', new TextEncoder().encode('hi')],
      ]),
    );
    expect(broken.issues.map((i) => [i.code, i.location])).toEqual([
      ['truncated_file', 'a.json'],
      ['invalid_record', 'b.json'],
      ['unknown_file', 'notes.txt'],
      ['no_conversations', undefined],
    ]);
    expect(broken.truncated).toBe(true);
  });
});

describe('telling exports apart', () => {
  it('recognises each source by its content, and says nothing when unsure', () => {
    expect(detectSystem(fixtureFiles(INTERCOM_DIR))).toBe('intercom');
    expect(detectSystem(zendeskFiles())).toBe('zendesk');
    expect(detectSystem(tawkFiles())).toBe('tawk.to');
    expect(detectSystem(new Map([['x.json', json({ hello: 'world' })]]))).toBeNull();
    // A bare ticket, without the wrapper or the API address.
    expect(
      detectSystem(new Map([['t.json', ndjson([{ id: 1, requester_id: 2, comments: [] }])]])),
    ).toBe('zendesk');
    expect(readExport(zip(fixtureFiles(INTERCOM_DIR)), 'intercom.zip', 'zendesk').detected).toBe(
      'intercom',
    );
  });
});

describe('HTML to text', () => {
  it('keeps paragraphs, line breaks, lists and link addresses, and drops everything else', () => {
    expect(
      htmlToText(
        '<p>Hi&nbsp;there</p><p>Line<br>break &amp; more &#8212; &#x1F600;</p>' +
          '<script>alert(1)</script><style>p{}</style><!-- hidden -->' +
          '<ol><li>One</li><li>Two</li></ol><a href="https://example.com/a?b=1&amp;c=2">docs</a> ' +
          '<a href="javascript:alert(1)">click</a> <a href="https://example.com">https://example.com</a>' +
          '<img src="https://example.com/x.png"> &bogus; &#0; &lt;b&gt;',
      ),
    ).toBe(
      'Hi there\nLine\nbreak & more — 😀\n\n- One\n- Two\ndocs (https://example.com/a?b=1&c=2) click https://example.com &bogus; &#0; <b>',
    );
  });
});
