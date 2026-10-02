import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  type ContactRecord,
  type ConversationRecord,
  type MessageRecord,
  type PackageInput,
  packageJsonSchema,
  parsePackage,
  planItems,
  readExport,
  readZip,
  toNdjson,
  writePackage,
} from '../src/index.js';
import { tawkZip, thrown, zip } from './helpers.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const contact: ContactRecord = {
  type: 'contact',
  id: 'c-1',
  source: { system: 'acme-desk', id: 'user-881', raw: { file: 'users.json', pointer: '/4' } },
  name: 'Bilal Ahmed',
  verified: { subject: 'cust_881', issuer: 'acme.example' },
  unverified: { email: 'bilal@example.net' },
  attributes: { plan: 'gold' },
};
const conversation: ConversationRecord = {
  type: 'conversation',
  id: 'conv-1',
  source: { system: 'acme-desk', id: '4411' },
  contactId: 'c-1',
  status: 'resolved',
  startedAt: '2026-08-01T08:00:00.000Z',
  endedAt: '2026-08-01T08:20:00.000Z',
  subject: 'Refund for order 7731',
  labels: ['refunds'],
  attributes: {},
};
const messages: MessageRecord[] = [
  {
    type: 'message',
    id: 'm-2',
    source: { system: 'acme-desk', id: '99002' },
    conversationId: 'conv-1',
    createdAt: '2026-08-01T08:05:00.000Z',
    author: { kind: 'agent', name: 'Hina', sourceId: 'agent-3' },
    visibility: 'internal',
    text: 'Customer is eligible; approve the refund.',
    attachmentIds: [],
  },
  {
    type: 'message',
    id: 'm-1',
    source: { system: 'acme-desk', id: '99001' },
    conversationId: 'conv-1',
    createdAt: '2026-08-01T08:00:00.000Z',
    author: { kind: 'customer', name: 'Bilal Ahmed' },
    visibility: 'public',
    text: 'میرا ریفنڈ کب آئے گا؟',
    attachmentIds: ['a-1'],
  },
];
const receipt = encoder.encode('%PDF-1.4 receipt');

function input(overrides: Partial<PackageInput> = {}): PackageInput {
  return {
    source: { system: 'acme-desk', schemaVersion: '3', exportedAt: '2026-09-01T00:00:00.000Z' },
    contacts: [contact],
    conversations: [conversation],
    messages,
    attachments: [
      {
        id: 'a-1',
        messageId: 'm-1',
        name: 'receipt.pdf',
        mediaType: 'application/pdf',
        bytes: receipt,
      },
    ],
    createdAt: new Date('2026-09-02T00:00:00.000Z'),
    ...overrides,
  };
}

/** Unpacks a written package, lets a test change files, and packs it again. */
function tamper(bytes: Uint8Array, change: (files: Map<string, Uint8Array>) => void): Uint8Array {
  const files = new Map(Object.entries(unzipSync(bytes)));
  change(files);
  return zip(files);
}

describe('Hamnivo package', () => {
  it('round-trips records, internal notes, raw references and attachment files', () => {
    const { parsed } = readExport(writePackage(input()), 'package.zip', 'hamnivo');
    expect(parsed.issues).toEqual([]);
    expect(parsed.truncated).toBe(false);
    expect(parsed.schemaVersion).toBe('v1');
    // Source IDs are unique within the system the manifest names.
    expect(parsed.origin).toEqual({ system: 'acme-desk', account: null });
    expect(parsed.contacts).toEqual([contact]);
    const [only] = parsed.conversations;
    expect(only?.record).toEqual(conversation);
    // Messages come back in time order, with visibility intact.
    expect(only?.messages.map((m) => [m.id, m.visibility])).toEqual([
      ['m-1', 'public'],
      ['m-2', 'internal'],
    ]);
    const attachment = parsed.attachments.get('a-1');
    expect(attachment?.problem).toBeNull();
    expect(attachment?.bytes && decoder.decode(attachment.bytes)).toBe('%PDF-1.4 receipt');
    expect(attachment?.entry.sha256).toBe(sha256(receipt));
  });

  it('writes a manifest with counts and checksums, and records in reading order', () => {
    const files = readZip(writePackage(input()));
    const manifest = JSON.parse(decoder.decode(files.get('manifest.json')));
    expect(manifest).toMatchObject({
      format: 'hamnivo.migration',
      version: 1,
      counts: { contacts: 1, conversations: 1, messages: 2, attachments: 1 },
      complete: true,
    });
    const records = files.get('records.ndjson') as Uint8Array;
    expect(manifest.checksums['records.ndjson']).toBe(sha256(records));
    const types = decoder
      .decode(records)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).type);
    expect(types).toEqual(['contact', 'conversation', 'message', 'message']);
  });

  it('matches its JSON Schema, which third parties can validate with', () => {
    const schema = packageJsonSchema();
    const committed = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', 'schema', 'hamnivo-migration-v1.schema.json'),
        'utf8',
      ),
    );
    expect(committed).toEqual(schema);
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    ajv.addSchema(schema);
    const validate = (def: string, value: unknown) =>
      ajv.validate({ $ref: `${schema.$id as string}#/$defs/${def}` }, value);
    const files = readZip(writePackage(input()));
    expect(validate('Manifest', JSON.parse(decoder.decode(files.get('manifest.json'))))).toBe(true);
    for (const line of decoder.decode(files.get('records.ndjson')).trim().split('\n')) {
      expect(validate('PackageRecord', JSON.parse(line)), line).toBe(true);
    }
    expect(
      validate('AttachmentsManifest', JSON.parse(decoder.decode(files.get('attachments.json')))),
    ).toBe(true);
    expect(validate('PackageRecord', { ...messages[0], visibility: 'secret' })).toBe(false);
    expect(validate('PackageRecord', { ...messages[0], createdAt: 'yesterday' })).toBe(false);
    // The writer refuses what the schema refuses.
    expect(() => toNdjson([{ ...messages[0], createdAt: 'yesterday' }])).toThrow();
  });

  it('quarantines a file referenced by a message but missing from the attachments manifest', () => {
    const bytes = writePackage(input({ attachments: [] }));
    const { parsed } = readExport(bytes, 'package.zip', 'hamnivo');
    expect(parsed.attachments.get('a-1')).toMatchObject({
      bytes: null,
      problem: 'missing_attachment',
    });
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({ code: 'missing_attachment', kind: 'attachment', sourceId: 'a-1' }),
    );
    const item = planItems(parsed).find((i) => i.kind === 'attachment');
    expect(item).toMatchObject({ status: 'quarantined', reason: 'missing_attachment' });
  });

  it('quarantines a listed file that is missing or altered', () => {
    const listed = tamper(writePackage(input()), (files) => {
      for (const name of files.keys()) if (name.startsWith('attachments/')) files.delete(name);
    });
    expect(readExport(listed, 'p.zip', 'hamnivo').parsed.attachments.get('a-1')?.problem).toBe(
      'missing_attachment',
    );
    const altered = tamper(writePackage(input()), (files) => {
      for (const name of files.keys()) {
        if (name.startsWith('attachments/')) files.set(name, encoder.encode('%PDF-1.4 changed!'));
      }
    });
    expect(readExport(altered, 'p.zip', 'hamnivo').parsed.attachments.get('a-1')?.problem).toBe(
      'checksum_mismatch',
    );
  });

  it('reports a package cut short: a partial last line and fewer records than declared', () => {
    const cut = tamper(writePackage(input()), (files) => {
      const text = decoder.decode(files.get('records.ndjson'));
      files.set('records.ndjson', encoder.encode(text.slice(0, text.length - 40)));
    });
    const { parsed } = readExport(cut, 'p.zip', 'hamnivo');
    expect(parsed.truncated).toBe(true);
    const codes = parsed.issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining(['checksum_mismatch', 'truncated_file', 'count_mismatch']),
    );
  });

  it('reads a bare NDJSON package that starts with its manifest', () => {
    const manifest = JSON.parse(
      decoder.decode(readZip(writePackage(input())).get('manifest.json')),
    );
    const text = `${JSON.stringify({ type: 'manifest', ...manifest, checksums: {} })}\n${toNdjson([contact, conversation, ...messages])}`;
    const { parsed, detected } = readExport(encoder.encode(text), 'history.ndjson', 'hamnivo');
    expect(detected).toBeNull();
    expect(parsed.conversations[0]?.messages).toHaveLength(2);
    // No attachments manifest travels with a bare file, so the file is quarantined.
    expect(parsed.attachments.get('a-1')?.problem).toBe('missing_attachment');
    expect(parsed.declared).toMatchObject({ messages: 2 });
  });

  it('reports invalid lines and duplicate IDs by line, without their content', () => {
    const text = [
      JSON.stringify(contact),
      JSON.stringify(conversation),
      JSON.stringify({ ...messages[1], visibility: 'everyone' }),
      JSON.stringify(messages[0]),
      JSON.stringify(messages[0]),
      '',
    ].join('\n');
    const parsed = parsePackage(new Map([['x.ndjson', encoder.encode(text)]]));
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        code: 'invalid_record',
        kind: 'message',
        sourceId: 'm-1',
        location: 'x.ndjson:3',
      }),
    );
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        code: 'duplicate_in_file',
        sourceId: 'm-2',
        location: 'x.ndjson:5',
      }),
    );
    expect(JSON.stringify(parsed.issues)).not.toContain('ریفنڈ');
  });

  it('refuses a package whose manifest is damaged', () => {
    const broken = tamper(writePackage(input()), (files) => {
      files.set('manifest.json', encoder.encode('{"format":"hamnivo.migration"'));
    });
    expect(thrown(() => readExport(broken, 'p.zip', 'hamnivo'))).toMatchObject({ code: 'corrupt' });
  });

  it('turns a tawk.to export into a package and back without losing anything', () => {
    const { parsed } = readExport(tawkZip(), 'tawk.zip', 'tawk.to');
    const bytes = writePackage({
      source: { system: 'tawk.to' },
      contacts: parsed.contacts,
      conversations: parsed.conversations.map((c) => c.record),
      messages: parsed.conversations.flatMap((c) => c.messages),
      attachments: [...parsed.attachments.values()].map(({ entry }) => ({
        id: entry.id,
        messageId: entry.messageId,
        name: entry.name,
        mediaType: entry.mediaType,
        bytes: null,
        url: entry.url ?? null,
        size: entry.size,
      })),
    });
    const again = readExport(bytes, 'p.zip', 'hamnivo').parsed;
    expect(again.conversations.map((c) => c.messages.map((m) => m.id))).toEqual(
      parsed.conversations.map((c) => c.messages.map((m) => m.id)),
    );
    // Links without files make the package incomplete, and say so.
    expect(again.issues.map((i) => i.code)).toContain('incomplete_package');
    expect(again.attachments.get(`1f0c6f40-9b3e-11ef-8d6a-2b7c9e4f5a10:1:0`)?.problem).toBe(
      'binary_not_in_export',
    );
  });
});
