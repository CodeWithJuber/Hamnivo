import { readdirSync, readFileSync } from 'node:fs';
import { ChatwootImporter } from '@hamnivo/chatwoot';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import {
  type ContactRecord,
  type ConversationRecord,
  type MessageRecord,
  type PackageAttachmentInput,
  writePackage,
  writeZip,
} from '@hamnivo/migration-sdk';
import { and, eq, isNull } from 'drizzle-orm';
import { expect } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import type { Client, Slice } from './slice-harness.js';

/** tawk.to fixtures of the SDK: the export shape tawk.to documents, with made-up people. */
const TAWK = new URL('../../../packages/migration-sdk/test/fixtures/tawk/', import.meta.url);

export function tawkZip(): Uint8Array {
  const files = new Map<string, Uint8Array>();
  for (const name of readdirSync(TAWK).sort()) {
    files.set(`Northline chats/${name}`, readFileSync(new URL(name, TAWK)));
  }
  return writeZip(files);
}

export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
/** A 1×1 PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const src = (id: string) => ({ system: 'acme-desk', id });

export const contacts: ContactRecord[] = [
  {
    type: 'contact',
    id: 'c-sara',
    source: src('u-17'),
    name: 'Sara Nguyen',
    verified: null,
    unverified: { email: 'sara.nguyen@example.com', phone: '+44 7700 900123' },
    attributes: { plan: 'gold' },
  },
  {
    type: 'contact',
    id: 'c-bilal',
    source: src('u-881'),
    name: 'بلال أحمد',
    verified: { subject: 'cust_881', issuer: 'acme.example' },
    unverified: {},
    attributes: {},
  },
];

const conversation = (
  id: string,
  contactId: string,
  status: ConversationRecord['status'],
  startedAt: string,
): ConversationRecord => ({
  type: 'conversation',
  id,
  source: src(id),
  contactId,
  status,
  startedAt,
  labels: ['imported'],
  attributes: { channel: 'chat' },
});

export const conversations: ConversationRecord[] = [
  conversation('conv-1', 'c-sara', 'resolved', '2026-08-01T09:00:00.000Z'),
  conversation('conv-2', 'c-bilal', 'open', '2026-08-02T10:00:00.000Z'),
  conversation('conv-3', 'c-sara', 'resolved', '2026-08-03T11:00:00.000Z'),
];

const message = (
  id: string,
  conversationId: string,
  createdAt: string,
  author: MessageRecord['author'],
  text: string,
  options: { internal?: boolean; attachmentIds?: string[] } = {},
): MessageRecord => ({
  type: 'message',
  id,
  source: src(id),
  conversationId,
  createdAt,
  author,
  visibility: options.internal ? 'internal' : 'public',
  text,
  attachmentIds: options.attachmentIds ?? [],
});

const customer = { kind: 'customer' as const };
const liam = { kind: 'agent' as const, name: 'Liam Davies', sourceId: 'agent-3' };

export const messages: MessageRecord[] = [
  message(
    'm-1',
    'conv-1',
    '2026-08-01T09:00:00.000Z',
    customer,
    'Hi, my order 4821 arrived damaged.',
    {
      attachmentIds: ['a-photo'],
    },
  ),
  message(
    'm-2',
    'conv-1',
    '2026-08-01T09:02:00.000Z',
    liam,
    'Internal: approve a replacement. Ask [@Omar](mention://user/12/Omar) to ship it.',
    { internal: true },
  ),
  message(
    'm-3',
    'conv-1',
    '2026-08-01T09:03:30.000Z',
    liam,
    'Sorry to hear that! A replacement is on its way.',
  ),
  message('m-4', 'conv-1', '2026-08-01T09:05:00.000Z', customer, 'Here is the receipt.', {
    attachmentIds: ['a-missing'],
  }),
  message('m-5', 'conv-2', '2026-08-02T10:00:00.000Z', customer, 'مرحبًا، أين طلبي؟'),
  message(
    'm-6',
    'conv-2',
    '2026-08-02T10:00:05.000Z',
    { kind: 'bot', name: 'Helper' },
    'Let me check that for you.',
  ),
  message(
    'm-7',
    'conv-2',
    '2026-08-02T10:01:00.000Z',
    { kind: 'system' },
    'Conversation assigned to Billing.',
  ),
  message('m-8', 'conv-3', '2026-08-03T11:00:00.000Z', customer, 'میرا ریفنڈ کب آئے گا؟'),
  message('m-9', 'conv-3', '2026-08-03T11:04:00.000Z', liam, 'Kal tak aa jayega. آپ کا شکریہ', {
    attachmentIds: ['a-eicar'],
  }),
];

export const attachments: PackageAttachmentInput[] = [
  { id: 'a-photo', messageId: 'm-1', name: 'damaged-box.png', mediaType: 'image/png', bytes: PNG },
  // a-missing is referenced by m-4 but deliberately left out of the attachments manifest.
  {
    id: 'a-eicar',
    messageId: 'm-9',
    name: 'refund-note.txt',
    mediaType: 'text/plain',
    bytes: Buffer.from(`note ${EICAR}`),
  },
];

export function helpdeskPackage(
  overrides: Partial<Parameters<typeof writePackage>[0]> = {},
): Uint8Array {
  return writePackage({
    source: { system: 'acme-desk', schemaVersion: '3' },
    contacts,
    conversations,
    messages,
    attachments,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });
}

export async function upload(
  owner: Client,
  brandId: string,
  source: 'tawk.to' | 'hamnivo',
  name: string,
  bytes: Uint8Array,
) {
  const created = await owner.post('/v1/admin/migrations', {
    brandId,
    source,
    file: { name, base64: Buffer.from(bytes).toString('base64') },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  return created.body as Record<string, any>;
}

export async function job(owner: Client, id: string) {
  const reply = await owner.get(`/v1/admin/migrations/${id}`);
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body as Record<string, any>;
}

export async function act(owner: Client, id: string, action: string, body: unknown = {}) {
  const reply = await owner.post(`/v1/admin/migrations/${id}/${action}`, body);
  expect(reply.status, `${action}: ${JSON.stringify(reply.body)}`).toBe(202);
  return reply.body as Record<string, any>;
}

/** Makes waiting outbox retries due now, as if their backoff had passed. */
export async function dueNow(slice: Slice, tenantPublicId: string) {
  await withTenant(slice.app, { tenantId: fromPublicId('tenant', tenantPublicId) }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(), lockedUntil: null })
      .where(and(isNull(schema.outboxEvents.processedAt))),
  );
}

/** Reads Chatwoot as the integration user of a tenant's connection. */
export async function chatwootOf(slice: Slice, tenantPublicId: string, connectionPublicId: string) {
  const runtime = await slice.worker
    .get(AuthorityRegistry)
    .get(fromPublicId('tenant', tenantPublicId), fromPublicId('connection', connectionPublicId));
  return {
    runtime,
    importer: new ChatwootImporter({
      baseUrl: runtime.baseUrl,
      accountId: runtime.accountId,
      token: runtime.integrationToken,
    }),
  };
}

export async function itemsOf(slice: Slice, tenantPublicId: string, jobPublicId: string) {
  return withTenant(slice.app, { tenantId: fromPublicId('tenant', tenantPublicId) }, (tx) =>
    tx
      .select()
      .from(schema.migrationItems)
      .where(eq(schema.migrationItems.jobId, fromPublicId('migration', jobPublicId))),
  );
}
