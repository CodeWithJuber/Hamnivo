import { randomUUID } from 'node:crypto';
import { provisionStaffUser } from '@hamnivo/chatwoot';
import type { WidgetSettings } from '@hamnivo/contracts';
import { fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentPublicId } from '../src/authority/extended-parts.js';
import { ReconcilerService } from '../src/authority/reconciler.service.js';
import { authorityMessageUuid } from '../src/authority/uuid.js';
import { EicarScanner, type Scanner, type ScanVerdict } from '../src/knowledge/scanner.js';
import { REPLY_WAITING_TOPIC, TRANSCRIPT_TOPIC } from '../src/widget/notify-queue.js';
import { authority, join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * The customer surface of the widget end to end (W02, W05, W06, W09, W17–W19, W22, W23, W25):
 * the gateway on a real port, the worker driven by hand, and the fake Chatwoot.
 */

/** The EICAR check, which a test can make unreachable (like ClamAV down) or failing. */
class SwitchableScanner implements Scanner {
  mode: 'normal' | 'unavailable' | 'throws' = 'normal';
  private readonly engine = new EicarScanner();
  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    if (this.mode === 'unavailable') {
      return Promise.resolve({ clean: false, engine: 'clamav', reason: 'scan_unavailable' });
    }
    if (this.mode === 'throws') return Promise.reject(new Error('clamd: connection reset'));
    return this.engine.scan(bytes);
  }
}

const scanner = new SwitchableScanner();
let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa6f5a40000000049454e44ae426082',
  'hex',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);

type Json = Record<string, any>;

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let other: { id: string; widgetId: string };
let agent: Awaited<ReturnType<typeof provisionStaffUser>>;
let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;
/** The identity key id of each brand, by widget id. */
const kids = new Map<string, string>();

async function settings(change: Partial<WidgetSettings>) {
  const current = await shop.owner.get(`/v1/admin/brands/${shop.brand.id}/widget-settings`);
  expect(current.status).toBe(200);
  const saved = await shop.owner.put(`/v1/admin/brands/${shop.brand.id}/widget-settings`, {
    ...(current.body.settings as WidgetSettings),
    ...change,
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return saved.body as { settings: WidgetSettings; configVersion: number };
}

async function newVisitor() {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  return visitor;
}

async function startConversation(visitor: Visitor, firstMessage?: string) {
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    ...(firstMessage ? { firstMessage } : {}),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  await slice.drain();
  return started.body.id as string;
}

/** Sends a file's own bytes, as the widget does. */
async function upload(visitor: Visitor, conversationId: string, name: string, bytes: Buffer) {
  const response = await slice.gw.app.inject({
    method: 'POST',
    url: `/v1/widget/conversations/${conversationId}/uploads?name=${encodeURIComponent(name)}`,
    headers: {
      authorization: `Bearer ${visitor.accessToken}`,
      'content-type': 'application/octet-stream',
    },
    payload: bytes,
  });
  return { status: response.statusCode, body: response.json() as Json };
}

function send(visitor: Visitor, conversationId: string, parts: unknown[], id = randomUUID()) {
  return visitor.call('POST', `/v1/widget/conversations/${conversationId}/messages`, {
    clientMessageId: id,
    parts,
  });
}

async function history(visitor: Visitor, conversationId: string, query = 'limit=100') {
  const page = await visitor.call(
    'GET',
    `/v1/widget/conversations/${conversationId}/messages?${query}`,
  );
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  return page.body as { items: Json[]; olderCursor: string | null; latestSequence: number };
}

/** Signs a customer in, as the website's backend would with its key. */
async function signIn(visitor: Visitor, subject: string, email?: string) {
  const assertion = await new SignJWT({
    name: `Customer ${subject}`,
    ...(email ? { email, email_verified: true } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: kids.get(visitor.widgetId) as string })
    .setSubject(subject)
    .setAudience(visitor.widgetId)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomUUID())
    .sign(keyPair.privateKey);
  const identified = await visitor.call('POST', '/v1/widget/identity', { assertion });
  expect(identified.status, JSON.stringify(identified.body)).toBe(200);
  visitor.adopt(identified.body);
  return identified.body as Json;
}

async function control(conversationId: string) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  if (!row) throw new Error('control missing');
  return row;
}

async function journal(conversationId: string) {
  return withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationJournal)
      .where(
        and(
          eq(
            schema.conversationJournal.conversationId,
            fromPublicId('conversation', conversationId),
          ),
          eq(schema.conversationJournal.lane, 'customer'),
        ),
      ),
  );
}

/** Chatwoot as a support agent uses it, calling its account API directly. */
async function asStaff(method: string, path: string, body?: unknown) {
  const response = await fetch(
    `${slice.fake.url}/api/v1/accounts/${shop.connection.accountId}${path}`,
    {
      method,
      headers: {
        api_access_token: agent.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
  );
  expect(response.status, `${method} ${path}`).toBeLessThan(300);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as Json | null;
}

async function staffReply(conversationId: string, content: string, isPrivate = false) {
  const { externalConversationId } = await control(conversationId);
  await asStaff('POST', `/conversations/${externalConversationId}/messages`, {
    content,
    message_type: 'outgoing',
    private: isPrivate,
  });
  await slice.drain();
}

/** Makes this tenant's reconciler cursors due now, runs one pass and settles the worker. */
async function reconcile() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.update(schema.reconcileCursors).set({ nextPollAt: new Date(Date.now() - 1000) }),
  );
  await slice.worker.get(ReconcilerService).drainOnce();
  await slice.drain();
}

/** Makes the waiting outbox events of a topic due now and runs them. */
async function dueNow(topic: string) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(and(eq(schema.outboxEvents.topic, topic), isNull(schema.outboxEvents.processedAt))),
  );
  await slice.drain();
}

async function outboxCount(topic: string, aggregateId: string) {
  const rows = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(
        and(eq(schema.outboxEvents.topic, topic), eq(schema.outboxEvents.aggregateId, aggregateId)),
      ),
  );
  return rows.length;
}

async function addDocument(sourceId: string, title: string, text: string) {
  const added = await shop.owner.post(`/v1/admin/knowledge/sources/${sourceId}/documents`, {
    title,
    content: { mediaType: 'text/plain', text },
  });
  expect(added.status, JSON.stringify(added.body)).toBe(202);
  await slice.drain();
}

/** The address in an email's List-Unsubscribe header. */
const unsubscribeLink = (header: string | undefined) =>
  /^<(.+)>$/.exec(header ?? '')?.[1] as string;

beforeAll(async () => {
  slice = await startSlice({
    clock,
    scanner,
    // Slow heartbeats: a stream that ends must end because it was told to (W18). Reply emails
    // wait an hour, so a test decides when they are due (W25).
    env: { STREAM_HEARTBEAT_SECONDS: '30', CUSTOMER_REPLY_EMAIL_DELAY_SECONDS: '3600' },
  });
  shop = await connectedTenant(slice, 'surface');
  tenantId = fromPublicId('tenant', shop.tenantId);
  const created = await shop.owner.post('/v1/admin/brands', {
    workspaceId: shop.workspaceId,
    name: 'Other Shop',
    allowedOrigins: ['https://other.example'],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  other = created.body;
  keyPair = await generateKeyPair('ES256');
  const jwk = await exportJWK(keyPair.publicKey);
  for (const brand of [shop.brand, other]) {
    const kid = `k-${randomUUID().slice(0, 8)}`;
    kids.set(brand.widgetId, kid);
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx.insert(schema.brandIdentityKeys).values({
        tenantId,
        brandId: fromPublicId('brand', brand.id),
        kid,
        alg: 'ES256',
        publicJwk: jwk,
      }),
    );
  }
  agent = await provisionStaffUser({
    baseUrl: slice.fake.url,
    platformToken: slice.fake.platformToken,
    accountId: shop.connection.accountId,
    name: 'Chatwoot Agent',
    email: `cw-agent-${randomUUID()}@example.com`,
    role: 'administrator',
  });
});

afterAll(async () => {
  await slice?.close();
});

describe('widget settings and the launcher (W02, W19)', () => {
  it('starts with a floating launcher, no proactive prompts and the default file limits', async () => {
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    const session = await visitor.open();
    expect(session.config).toMatchObject({
      layout: { mode: 'bubble', position: 'bottom-right' },
      features: { attachments: true, helpCenter: true },
      attachmentLimits: { maxBytes: 10 * 1024 * 1024, maxFiles: 5 },
      messageDeletion: { windowSeconds: 600 },
      notifications: { email: true },
      proactive: { triggers: [] },
    });
    const launcher = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}&locale=ar`,
      { headers: { origin: shop.hostOrigin } },
    );
    expect(launcher.status).toBe(200);
    // The loader on the brand's website may read it; the answer varies by website.
    expect(launcher.headers.get('access-control-allow-origin')).toBe(shop.hostOrigin);
    expect(launcher.headers.get('vary')).toMatch(/origin/i);
    expect(await launcher.json()).toMatchObject({
      widgetId: shop.brand.widgetId,
      locale: 'ar',
      dir: 'rtl',
      layout: { mode: 'bubble', position: 'bottom-right' },
      launcher: { openLabel: 'فتح المحادثة', unreadLabel: '{count} غير مقروءة' },
      proactive: { enabled: false, triggers: [] },
    });
  });

  it('refuses the launcher configuration to websites the brand did not allow', async () => {
    const refused = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}`,
      { headers: { origin: 'https://evil.example' } },
    );
    expect(refused.status).toBe(403);
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    const unknown = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=wid_01j9zk7w3xq8r4t2v6m5n1p0cd`,
    );
    expect(unknown.status).toBe(404);
  });

  it('applies a brand’s layout and help suggestions to new sessions at once', async () => {
    const before = await shop.owner.get(`/v1/admin/brands/${shop.brand.id}/widget-settings`);
    const saved = await settings({
      layout: { mode: 'panel', position: 'bottom-left' },
      help: {
        suggestions: [
          { en: 'Where is my order?', ar: 'أين طلبي؟' },
          { en: 'How do returns work?' },
        ],
        search: true,
      },
    });
    expect(saved.configVersion).toBe(before.body.configVersion + 1);
    const session = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(session.config.layout).toEqual({ mode: 'panel', position: 'bottom-left' });
    expect(session.config.brand.launcherPosition).toBe('bottom-left');
    // Each language falls back to the brand's English.
    expect(session.config.help.suggestions.ar).toEqual(['أين طلبي؟', 'How do returns work?']);
    expect(session.config.help.suggestions.ur).toEqual([
      'Where is my order?',
      'How do returns work?',
    ]);
    const svg = await shop.owner.put(`/v1/admin/brands/${shop.brand.id}/widget-settings`, {
      attachments: { allowedTypes: ['image/svg+xml'] },
    });
    expect(svg.status).toBe(422);
    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'brand.widget_settings.updated')),
    );
    expect(audit).toHaveLength(1);
    await settings({
      layout: { mode: 'bubble', position: 'bottom-right' },
      help: { suggestions: [], search: true },
    });
  });

  it('keeps proactive prompts behind their own permission, off until a brand turns them on', async () => {
    const developer = await join(slice, shop, 'Dev Eloper', 'developer');
    const path = `/v1/admin/brands/${shop.brand.id}`;
    expect((await developer.client.get(`${path}/widget-settings`)).status).toBe(200);
    expect((await developer.client.get(`${path}/proactive`)).status).toBe(403);
    expect(
      (await developer.client.put(`${path}/proactive`, { enabled: true, triggers: [] })).status,
    ).toBe(403);

    const off = await shop.owner.get(`${path}/proactive`);
    expect(off.body.settings).toMatchObject({ enabled: false, triggers: [], maxPerDay: 1 });
    // No setting can show a visitor more than three prompts a day, or one at once.
    const spam = await shop.owner.put(`${path}/proactive`, { enabled: true, maxPerDay: 10 });
    expect(spam.status).toBe(422);
    const eager = await shop.owner.put(`${path}/proactive`, {
      enabled: true,
      triggers: [{ id: 'now', kind: 'time_on_page', seconds: 2, message: { en: 'Hi!' } }],
    });
    expect(eager.status).toBe(422);
    const on = await shop.owner.put(`${path}/proactive`, {
      enabled: true,
      maxPerDay: 2,
      dismissHours: 12,
      triggers: [
        {
          id: 'pricing',
          kind: 'page_path',
          path: '/pricing',
          message: { en: 'Questions about plans? Ask us.', ur: 'پلانز کے بارے میں سوال؟' },
        },
        { id: 'linger', kind: 'time_on_page', seconds: 30, message: { en: 'Need a hand?' } },
      ],
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const launcher = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}&locale=ur`,
    );
    expect((await launcher.json()).proactive).toEqual({
      enabled: true,
      maxPerDay: 2,
      dismissHours: 12,
      triggers: [
        {
          id: 'pricing',
          kind: 'page_path',
          path: '/pricing',
          seconds: 5,
          visits: null,
          message: 'پلانز کے بارے میں سوال؟',
        },
        {
          id: 'linger',
          kind: 'time_on_page',
          path: null,
          seconds: 30,
          visits: null,
          message: 'Need a hand?',
        },
      ],
    });
    const session = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
    expect(session.config.proactive.triggers.map((t: Json) => t.id)).toEqual(['pricing', 'linger']);

    // Only while people work: this brand has no hours, so nobody is known to be working.
    const quiet = await shop.owner.put(`${path}/proactive`, {
      ...on.body.settings,
      onlyWhenAvailable: true,
    });
    expect(quiet.status).toBe(200);
    const silent = await fetch(
      `${slice.baseUrl}/v1/widget/launcher?widgetId=${shop.brand.widgetId}`,
    );
    expect((await silent.json()).proactive).toMatchObject({ enabled: false, triggers: [] });
    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ data: schema.auditEvents.data })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.action, 'brand.proactive.updated')),
    );
    expect(audit).toHaveLength(2);
    expect((await shop.owner.put(`${path}/proactive`, { enabled: false })).status).toBe(200);
  });
});

describe('files (W09)', () => {
  let visitor: Visitor;
  let conversationId: string;

  beforeAll(async () => {
    visitor = await newVisitor();
    conversationId = await startConversation(visitor, 'I have a photo of the damage');
  });

  it('reads the type from the bytes, scans the file and keeps it in quarantine', async () => {
    const photo = await upload(visitor, conversationId, '../../etc/damage.PDF', PNG);
    expect(photo.status, JSON.stringify(photo.body)).toBe(201);
    expect(photo.body).toEqual({
      type: 'attachment',
      uploadId: expect.stringMatching(/^upl_/),
      name: 'damage.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      status: 'available',
    });
    const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.widgetUploads)
        .where(eq(schema.widgetUploads.id, fromPublicId('upload', photo.body.uploadId))),
    );
    expect(row).toMatchObject({ status: 'available', scanEngine: 'eicar', clientMessageId: null });
    expect(row?.content?.equals(PNG)).toBe(true);
  });

  it('refuses programs, unknown types, harmful files and anything it could not scan', async () => {
    const program = await upload(visitor, conversationId, 'invoice.pdf', EXE);
    expect(program.status).toBe(422);
    expect(program.body).toMatchObject({ code: 'UPLOAD_REJECTED', reason: 'type_not_allowed' });
    const text = await upload(visitor, conversationId, 'notes.txt', Buffer.from('just text'));
    expect(text.body.reason).toBe('type_not_allowed');
    const infected = await upload(
      visitor,
      conversationId,
      'receipt.pdf',
      Buffer.concat([PDF.subarray(0, 9), Buffer.from(EICAR), PDF.subarray(9)]),
    );
    expect(infected.status).toBe(422);
    expect(infected.body).toMatchObject({ code: 'UPLOAD_REJECTED', reason: 'malware_detected' });
    try {
      scanner.mode = 'unavailable';
      const unchecked = await upload(visitor, conversationId, 'receipt.pdf', PDF);
      expect(unchecked.body).toMatchObject({
        code: 'UPLOAD_REJECTED',
        reason: 'scan_unavailable',
      });
      scanner.mode = 'throws';
      const crashed = await upload(visitor, conversationId, 'receipt.pdf', PDF);
      expect(crashed.body.reason).toBe('scan_unavailable');
    } finally {
      scanner.mode = 'normal';
    }
    // Refused files are recorded without their bytes.
    const refused = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({
          content: schema.widgetUploads.content,
          reason: schema.widgetUploads.rejectionReason,
        })
        .from(schema.widgetUploads)
        .where(eq(schema.widgetUploads.status, 'rejected')),
    );
    expect(refused.map((r) => r.reason).sort()).toEqual([
      'malware_detected',
      'scan_unavailable',
      'scan_unavailable',
      'type_not_allowed',
      'type_not_allowed',
    ]);
    expect(refused.every((r) => r.content === null)).toBe(true);
  });

  it('applies the brand’s size and count limits, and its switch', async () => {
    await settings({
      attachments: {
        enabled: true,
        allowedTypes: ['image/png', 'application/pdf'],
        maxMegabytes: 1,
        maxFiles: 2,
      },
    });
    try {
      const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024, 0x20)]);
      const tooBig = await upload(visitor, conversationId, 'big.pdf', big);
      expect(tooBig.status).toBe(413);
      expect(tooBig.body).toMatchObject({ code: 'UPLOAD_TOO_LARGE', reason: 'too_large' });
      // Past the largest size any brand may allow, the request itself is refused.
      const huge = await upload(visitor, conversationId, 'huge.pdf', Buffer.alloc(11 << 20, 0x20));
      expect(huge.status).toBe(413);
      // The picture from the first test is still waiting: one more fits, then no more.
      expect((await upload(visitor, conversationId, 'two.pdf', PDF)).status).toBe(201);
      const third = await upload(visitor, conversationId, 'three.pdf', PDF);
      expect(third.body).toMatchObject({ code: 'UPLOAD_REJECTED', reason: 'too_many' });

      await settings({
        attachments: { enabled: false, allowedTypes: ['image/png'], maxMegabytes: 1, maxFiles: 2 },
      });
      const off = await upload(visitor, conversationId, 'x.png', PNG);
      expect(off.status).toBe(403);
      expect(off.body.code).toBe('FEATURE_DISABLED');
      const session = await new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin).open();
      expect(session.config.features.attachments).toBe(false);
    } finally {
      await settings({
        attachments: {
          enabled: true,
          allowedTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'],
          maxMegabytes: 10,
          maxFiles: 5,
        },
      });
    }
  });

  it('sends scanned files with one message, once, then serves them only to their customer', async () => {
    const pending = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.widgetUploads.id, name: schema.widgetUploads.name })
        .from(schema.widgetUploads)
        .where(
          and(
            eq(schema.widgetUploads.conversationId, fromPublicId('conversation', conversationId)),
            eq(schema.widgetUploads.status, 'available'),
          ),
        )
        .orderBy(schema.widgetUploads.createdAt),
    );
    expect(pending.map((p) => p.name)).toEqual(['damage.png', 'two.pdf']);
    const parts = [
      { type: 'text', text: 'Here are the photo and the receipt' },
      ...pending.map((p) => ({ type: 'attachment', uploadId: toPublicId('upload', p.id) })),
    ];
    const clientMessageId = randomUUID();
    const sent = await send(visitor, conversationId, parts, clientMessageId);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const sentFiles = sent.body.message.parts.filter((p: Json) => p.type === 'attachment');
    expect(sentFiles.map((f: Json) => f.name)).toEqual(['damage.png', 'two.pdf']);
    // A retry of the same message sends nothing again.
    const retried = await send(visitor, conversationId, parts, clientMessageId);
    expect(retried.status).toBe(202);
    expect(retried.body.status).toBe('duplicate');
    await slice.drain();
    const { messages } = await authority(slice, shop, conversationId);
    const withFiles = messages.filter((m) => m.attachments.length > 0);
    expect(withFiles).toHaveLength(1);
    expect(withFiles[0]?.attachments.map((a) => a.name)).toEqual(['damage.png', 'two.pdf']);
    // The authority owns the files now: nothing is left in quarantine.
    const after = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({
          status: schema.widgetUploads.status,
          content: schema.widgetUploads.content,
          authorityMessageId: schema.widgetUploads.authorityMessageId,
        })
        .from(schema.widgetUploads)
        .where(
          inArray(
            schema.widgetUploads.id,
            pending.map((p) => p.id),
          ),
        ),
    );
    expect(after).toEqual([
      { status: 'sent', content: null, authorityMessageId: Number(withFiles[0]?.ref) },
      { status: 'sent', content: null, authorityMessageId: Number(withFiles[0]?.ref) },
    ]);
    // A sent file cannot travel with another message.
    const reused = await send(visitor, conversationId, [parts[1]]);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('UPLOAD_REJECTED');

    // History lists files by their own ids; their addresses in Chatwoot never reach the page.
    const page = await history(visitor, conversationId);
    const listed = page.items
      .flatMap((m) => m.parts as Json[])
      .filter((p) => p.type === 'attachment');
    const photo = listed.find((p) => p.name === 'damage.png') as Json;
    expect(photo).toMatchObject({ mimeType: 'image/png', status: 'available' });
    expect(JSON.stringify(page)).not.toMatch(/active_storage|rails/);
    const fileUrl = `${slice.baseUrl}/v1/widget/conversations/${conversationId}/attachments/${photo.uploadId}`;
    const download = await fetch(fileUrl, {
      headers: { authorization: `Bearer ${visitor.accessToken}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename="damage\.png"/,
    );
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toContain('sandbox');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await download.arrayBuffer()).equals(PNG)).toBe(true);

    const stranger = await newVisitor();
    const stolen = await fetch(fileUrl, {
      headers: { authorization: `Bearer ${stranger.accessToken}` },
    });
    expect(stolen.status).toBe(404);
    expect((await fetch(fileUrl)).status).toBe(401);
    const guessed = await fetch(
      `${slice.baseUrl}/v1/widget/conversations/${conversationId}/attachments/upl_01j9zk7w3xq8r4t2v6m5n1p0cd`,
      { headers: { authorization: `Bearer ${visitor.accessToken}` } },
    );
    expect(guessed.status).toBe(404);
  });

  it('never serves a file from a private note, and blocks a harmful file staff sent', async () => {
    const { runtime, ref } = await authority(slice, shop, conversationId);
    await runtime.authority.appendMessage({
      conversationRef: ref,
      key: `test:${randomUUID()}`,
      author: { kind: 'integration' },
      visibility: 'private',
      text: 'Internal: the courier report',
      attachments: [{ name: 'courier.pdf', mimeType: 'application/pdf', bytes: PDF }],
    });
    await runtime.authority.appendMessage({
      conversationRef: ref,
      key: `test:${randomUUID()}`,
      author: { kind: 'integration' },
      visibility: 'public',
      text: 'Here is the return label',
      attachments: [
        {
          name: 'label.pdf',
          mimeType: 'application/pdf',
          bytes: Buffer.concat([PDF, Buffer.from(EICAR)]),
        },
      ],
    });
    await slice.drain();
    const page = await history(visitor, conversationId);
    expect(JSON.stringify(page)).not.toContain('courier');
    const label = page.items
      .flatMap((m) => m.parts as Json[])
      .find((p) => p.name === 'label.pdf') as Json;
    expect(label).toBeDefined();
    const blocked = await fetch(
      `${slice.baseUrl}/v1/widget/conversations/${conversationId}/attachments/${label.uploadId}`,
      { headers: { authorization: `Bearer ${visitor.accessToken}` } },
    );
    expect(blocked.status).toBe(422);
    expect((await blocked.json()).reason).toBe('malware_detected');
    // The private note's file has an id like any other, which the customer cannot use.
    const { messages, control: row } = await authority(slice, shop, conversationId);
    const note = messages.find((m) => m.private && m.attachments.length > 0);
    expect(note?.attachments[0]?.name).toBe('courier.pdf');
    const noteFile = attachmentPublicId(
      toPublicId('message', authorityMessageUuid(row.connectionId, note?.ref as string)),
      note?.attachments[0]?.ref as string,
    );
    const hidden = await fetch(
      `${slice.baseUrl}/v1/widget/conversations/${conversationId}/attachments/${noteFile}`,
      { headers: { authorization: `Bearer ${visitor.accessToken}` } },
    );
    expect(hidden.status).toBe(404);
  });
});

describe('read state and delivery (W05, W06)', () => {
  let readConversation: string;
  let reader: Visitor;

  it('counts unread replies, clears them when the customer reads, and tells Chatwoot', async () => {
    reader = await newVisitor();
    readConversation = await startConversation(reader, 'Do you deliver to Multan?');
    await staffReply(readConversation, 'Yes, in three days.');
    const replies = (await journal(readConversation)).filter(
      (e) =>
        e.eventType === 'message.created' &&
        (e.event as Json).data.message.sender.kind !== 'customer',
    );
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const view = await reader.call('GET', `/v1/widget/conversations/${readConversation}`);
    expect(view.body.unreadCount).toBe(replies.length);
    const list = await reader.call('GET', '/v1/widget/conversations');
    expect(list.body.items[0]).toMatchObject({
      id: readConversation,
      unreadCount: replies.length,
      lastMessagePreview: 'Yes, in three days.',
    });

    const read = await reader.call('POST', `/v1/widget/conversations/${readConversation}/read`, {
      upToSequence: view.body.latestSequence,
    });
    expect(read.status).toBe(204);
    const after = await reader.call('GET', `/v1/widget/conversations/${readConversation}`);
    expect(after.body.unreadCount).toBe(0);
    const { externalConversationId } = await control(readConversation);
    const chatwoot = await asStaff('GET', `/conversations/${externalConversationId}`);
    expect(chatwoot?.contact_last_seen_at).toBeGreaterThan(0);
    // A read point past the end is held at the end, so later replies still count.
    const ahead = await reader.call('POST', `/v1/widget/conversations/${readConversation}/read`, {
      upToSequence: 1_000_000,
    });
    expect(ahead.status).toBe(204);
    await staffReply(readConversation, 'Anything else?');
    const later = await reader.call('GET', `/v1/widget/conversations/${readConversation}`);
    expect(later.body.unreadCount).toBe(1);
  });

  it('marks the customer’s messages read once Chatwoot reports staff saw them', async () => {
    const visitor = await newVisitor();
    const id = await startConversation(visitor);
    const first = await send(visitor, id, [{ type: 'text', text: 'Is the red kettle in stock?' }]);
    expect(first.status).toBe(202);
    await slice.drain();
    const messageId = first.body.message.id as string;
    const stream = visitor.stream(id);
    await stream.ready;
    const before = await history(visitor, id);
    expect(before.items.find((m) => m.id === messageId)?.delivery).toBe('accepted');
    // Chatwoot keeps whole seconds: the agent looks in a later second than the message.
    await sleep(1100);
    const { externalConversationId } = await control(id);
    await asStaff('POST', `/conversations/${externalConversationId}/update_last_seen`);
    // Looking sends no webhook; the reconciler reads it.
    await reconcile();
    await stream.until((s) => s.events.some((e) => e.type === 'delivery.updated'));
    expect(stream.events.filter((e) => e.type === 'delivery.updated').map((e) => e.data)).toEqual([
      { messageId, state: 'read' },
    ]);
    const after = await history(visitor, id);
    expect(after.items.find((m) => m.id === messageId)?.delivery).toBe('read');
    // Nothing new seen, nothing new claimed.
    await reconcile();
    await sleep(100);
    expect(stream.events.filter((e) => e.type === 'delivery.updated')).toHaveLength(1);
    stream.close();
  });

  it('pages through older history and refuses unknown cursors', async () => {
    const all = await history(reader, readConversation);
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    const first = await history(reader, readConversation, 'limit=1');
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.id).toBe(all.items[0]?.id);
    expect(first.olderCursor).not.toBeNull();
    const second = await history(
      reader,
      readConversation,
      `limit=1&before=${first.olderCursor as string}`,
    );
    expect(second.items[0]?.id).toBe(all.items[1]?.id);
    const cursor = Buffer.from('not-a-number').toString('base64url');
    const bad = await reader.call(
      'GET',
      `/v1/widget/conversations/${readConversation}/messages?before=${cursor}`,
    );
    expect(bad.status).toBe(422);
  });
});

describe('deleting one’s own message (W23)', () => {
  it('deletes within the window, keeps a marker and scrubs every stored copy', async () => {
    const visitor = await newVisitor();
    const id = await startConversation(visitor);
    const sent = await send(visitor, id, [
      { type: 'text', text: 'Oops, wrong window: 12 Canal Road, flat 7' },
    ]);
    expect(sent.status).toBe(202);
    await slice.drain();
    const messageId = sent.body.message.id as string;
    const stream = visitor.stream(id);
    await stream.ready;
    const path = `/v1/widget/conversations/${id}/messages/${messageId}/delete`;
    const deleted = await visitor.call('POST', path);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body).toEqual({ messageId, deletedAt: expect.any(String) });
    // Chatwoot reports the deletion too; the lane still hears it once.
    await slice.drain();
    await stream.until((s) => s.events.some((e) => e.type === 'message.redacted'));
    expect((await visitor.call('POST', path)).status).toBe(200);
    await slice.drain();
    const events = await journal(id);
    expect(events.filter((e) => e.eventType === 'message.redacted')).toHaveLength(1);
    expect(JSON.stringify(events.map((e) => e.event))).not.toContain('Canal Road');
    const { messages } = await authority(slice, shop, id);
    expect(messages.some((m) => m.text?.includes('Canal Road'))).toBe(false);
    expect(messages.filter((m) => m.contentAttributes.deleted === true)).toHaveLength(1);
    const page = await history(visitor, id);
    expect(page.items.find((m) => m.id === messageId)?.parts).toEqual([
      { type: 'notice', notice: 'message_deleted', text: 'This message was deleted.' },
    ]);
    stream.close();
  });

  it('refuses after the window, for messages that are not the customer’s, and when off', async () => {
    const visitor = await newVisitor();
    const id = await startConversation(visitor);
    const sent = await send(visitor, id, [{ type: 'text', text: 'One more thing' }]);
    await slice.drain();
    const path = (messageId: string) =>
      `/v1/widget/conversations/${id}/messages/${messageId}/delete`;
    offsetMs = 11 * 60_000;
    try {
      const late = await visitor.call('POST', path(sent.body.message.id));
      expect(late.status).toBe(409);
      expect(late.body.code).toBe('DELETE_WINDOW_CLOSED');
    } finally {
      offsetMs = 0;
    }
    await staffReply(id, 'We are here to help.');
    const reply = (await history(visitor, id)).items.find((m) => m.sender.kind === 'human_agent');
    expect(reply).toBeDefined();
    expect((await visitor.call('POST', path(reply?.id))).status).toBe(404);
    const stranger = await newVisitor();
    expect((await stranger.call('POST', path(sent.body.message.id))).status).toBe(404);

    const fresh = await send(visitor, id, [{ type: 'text', text: 'Please ignore that' }]);
    await settings({ deletion: { windowMinutes: 0 } });
    try {
      const off = await visitor.call('POST', path(fresh.body.message.id));
      expect(off.status).toBe(403);
      expect(off.body.code).toBe('FEATURE_DISABLED');
    } finally {
      await settings({ deletion: { windowMinutes: 10 } });
    }
  });
});

describe('reactions (W22)', () => {
  it('sends a reaction once, quoting the reply, and asks nobody to answer it', async () => {
    const visitor = await newVisitor();
    const id = await startConversation(visitor);
    const conversation = await control(id);
    await staffReply(id, 'Your refund is on its way.');
    const reply = (await history(visitor, id)).items.find((m) => m.sender.kind === 'human_agent');
    expect(reply).toBeDefined();
    const jobs = await outboxCount('conversation.customer_message', conversation.id);
    const body = { clientMessageId: randomUUID(), emoji: '🙏' };
    const path = `/v1/widget/conversations/${id}/messages/${reply?.id}/reactions`;
    const reacted = await visitor.call('POST', path, body);
    expect(reacted.status, JSON.stringify(reacted.body)).toBe(202);
    expect(reacted.body.message.parts).toEqual([
      { type: 'reaction', emoji: '🙏', messageId: reply?.id },
    ]);
    await slice.drain();
    expect((await visitor.call('POST', path, body)).body.status).toBe('duplicate');
    expect(await outboxCount('conversation.customer_message', conversation.id)).toBe(jobs);
    const { messages } = await authority(slice, shop, id);
    const quoted = messages.find((m) => m.text === 'Your refund is on its way.');
    const reactions = messages.filter((m) => m.text === '🙏');
    expect(reactions).toHaveLength(1);
    expect(reactions[0]?.contentAttributes.in_reply_to).toBe(Number(quoted?.ref));
    // An ordinary message does ask for an answer, which the count above would have caught.
    await send(visitor, id, [{ type: 'text', text: 'Thank you!' }]);
    expect(await outboxCount('conversation.customer_message', conversation.id)).toBe(jobs + 1);

    const own = (await history(visitor, id)).items.find((m) => m.sender.kind === 'customer');
    const self = await visitor.call(
      'POST',
      `/v1/widget/conversations/${id}/messages/${own?.id}/reactions`,
      { clientMessageId: randomUUID(), emoji: '👍' },
    );
    expect(self.status).toBe(404);
    const unknown = await visitor.call('POST', path, {
      clientMessageId: randomUUID(),
      emoji: '🔥',
    });
    expect(unknown.status).toBe(422);
  });
});

describe('help before a conversation (W17)', () => {
  it('finds the brand’s public knowledge only', async () => {
    const help = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: shop.brand.id,
      name: 'Help centre',
    });
    const handbook = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: shop.brand.id,
      name: 'Staff handbook',
      visibility: 'internal',
    });
    const elsewhere = await shop.owner.post('/v1/admin/knowledge/sources', {
      brandId: other.id,
      name: 'Other help',
    });
    await addDocument(
      help.body.id,
      'Returns policy',
      'Returns are accepted within 14 days of delivery with the receipt.',
    );
    await addDocument(
      handbook.body.id,
      'VIP returns',
      'Staff only: returns from VIP customers are accepted after 14 days.',
    );
    await addDocument(
      elsewhere.body.id,
      'Other returns',
      'Returns at the other shop are accepted within 30 days.',
    );
    const visitor = await newVisitor();
    const found = await visitor.call('GET', '/v1/widget/help/search?q=returns%20accepted');
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(found.body.items.map((i: Json) => i.title)).toEqual(['Returns policy']);
    expect(found.body.items[0]).toMatchObject({
      id: expect.stringMatching(/^doc_/),
      excerpt: 'Returns are accepted within 14 days of delivery with the receipt.',
      version: expect.any(Number),
    });
    expect((await visitor.call('GET', '/v1/widget/help/search?q=')).status).toBe(422);
  });

  it('can be turned off, and limits searches per session', async () => {
    await settings({ help: { suggestions: [], search: false } });
    try {
      const visitor = await newVisitor();
      const off = await visitor.call('GET', '/v1/widget/help/search?q=returns');
      expect(off.status).toBe(403);
      expect(off.body.code).toBe('FEATURE_DISABLED');
    } finally {
      await settings({ help: { suggestions: [], search: true } });
    }
    const visitor = await newVisitor();
    for (let i = 0; i < 20; i += 1) {
      expect((await visitor.call('GET', '/v1/widget/help/search?q=returns')).status).toBe(200);
    }
    const limited = await visitor.call('GET', '/v1/widget/help/search?q=returns');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});

describe('continuing on another device (W18)', () => {
  it('shows a verified customer their conversations on every device, and nobody else’s', async () => {
    const phone = await newVisitor();
    await signIn(phone, 'cust-continue', 'sana@example.com');
    const id = await startConversation(phone, 'I ordered the blue kettle on my phone');

    // Another device, anonymous at first, sees nothing of it.
    const laptop = await newVisitor();
    expect((await laptop.call('GET', '/v1/widget/conversations')).body.items).toEqual([]);
    expect((await laptop.call('GET', `/v1/widget/conversations/${id}`)).status).toBe(404);
    // Signed in as the same customer, it continues the same conversation.
    const signedIn = await signIn(laptop, 'cust-continue');
    expect(signedIn.conversations.map((c: Json) => c.id)).toEqual([id]);
    const phoneStream = phone.stream(id);
    await phoneStream.ready;
    const fromLaptop = await send(laptop, id, [{ type: 'text', text: 'Continuing on my laptop' }]);
    expect(fromLaptop.status).toBe(202);
    await phoneStream.until((s) =>
      s.events.some(
        (e) => e.type === 'message.created' && e.data.message.id === fromLaptop.body.message.id,
      ),
    );
    phoneStream.close();

    // Another customer sees none of it, by any path.
    const stranger = await newVisitor();
    expect((await signIn(stranger, 'cust-someone-else')).conversations).toEqual([]);
    for (const path of [`/${id}`, `/${id}/messages`]) {
      expect((await stranger.call('GET', `/v1/widget/conversations${path}`)).status).toBe(404);
    }
    expect((await upload(stranger, id, 'x.png', PNG)).status).toBe(404);
    expect((await stranger.stream(id).ready).status).toBe(404);
    // The same person signed in on another brand of the business is another customer there.
    const otherSite = new Visitor(slice.baseUrl, other.widgetId, 'https://other.example');
    await otherSite.open();
    expect((await signIn(otherSite, 'cust-continue')).conversations).toEqual([]);
    expect((await otherSite.call('GET', `/v1/widget/conversations/${id}`)).status).toBe(404);
  });

  it('ends a device’s open streams at once when it signs in as someone else or signs out', async () => {
    const device = await newVisitor();
    await signIn(device, 'cust-switch-a');
    const first = await startConversation(device, 'Checking my order');
    const stream = device.stream(first);
    await stream.ready;
    const started = Date.now();
    await signIn(device, 'cust-switch-b');
    // The heartbeat is 30 seconds here: only the signal ends the stream this fast.
    await stream.until(
      (s) => s.ended && s.controls.some((c) => c.control === 'auth_expired'),
      5000,
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await device.call('GET', `/v1/widget/conversations/${first}`)).status).toBe(404);

    const second = await startConversation(device);
    const again = device.stream(second);
    await again.ready;
    expect((await device.call('POST', '/v1/widget/sessions/reset')).status).toBe(204);
    await again.until((s) => s.ended && s.controls.some((c) => c.control === 'auth_expired'), 5000);
  });
});

describe('customer emails (W25)', () => {
  const email = `amina.${randomUUID().slice(0, 6)}@example.com`;
  let visitor: Visitor;
  let id: string;
  const mails = () => slice.workerMailer.messages.filter((m) => m.to === email);

  it('are offered to verified customers with a verified address, where the brand sends them', async () => {
    const anonymous = await newVisitor();
    expect((await anonymous.call('GET', '/v1/widget/notifications')).body).toEqual({
      available: false,
      reason: 'not_verified',
      email: null,
      transcript: false,
      replyWaiting: false,
    });
    const refused = await anonymous.call('POST', '/v1/widget/notifications', { transcript: true });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('IDENTITY_REQUIRED');
    const noAddress = await newVisitor();
    await signIn(noAddress, 'cust-no-address');
    expect((await noAddress.call('GET', '/v1/widget/notifications')).body.reason).toBe(
      'no_verified_email',
    );

    visitor = await newVisitor();
    await signIn(visitor, 'cust-amina', email);
    expect((await visitor.call('GET', '/v1/widget/notifications')).body).toEqual({
      available: true,
      reason: null,
      email: 'a•••@example.com',
      transcript: false,
      replyWaiting: false,
    });
    await settings({ notifications: { email: false } });
    try {
      const off = await visitor.call('GET', '/v1/widget/notifications');
      expect(off.body).toMatchObject({ available: false, reason: 'turned_off_by_brand' });
      const blocked = await visitor.call('POST', '/v1/widget/notifications', {
        replyWaiting: true,
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('FEATURE_DISABLED');
    } finally {
      await settings({ notifications: { email: true } });
    }
    expect((await visitor.call('POST', '/v1/widget/notifications', {})).status).toBe(422);
    const chosen = await visitor.call('POST', '/v1/widget/notifications', {
      transcript: true,
      replyWaiting: true,
    });
    expect(chosen.body).toMatchObject({ available: true, transcript: true, replyWaiting: true });
  });

  it('emails a waiting reply once, and not when it was read or soon after the last email', async () => {
    id = await startConversation(visitor, 'Where is my parcel?');
    await staffReply(id, 'Your parcel left our warehouse today.');
    expect(mails()).toHaveLength(0);
    await dueNow(REPLY_WAITING_TOPIC);
    expect(mails()).toHaveLength(1);
    const mail = mails()[0];
    expect(mail?.template).toBe('customer.reply_waiting');
    expect(mail?.subject).toContain('surface Shop');
    // The reply itself stays in the chat; the email points to the website.
    expect(mail?.text).not.toContain('warehouse');
    expect(mail?.text).toContain(shop.hostOrigin);
    expect(mail?.headers?.['List-Unsubscribe']).toMatch(
      /^<http:\/\/127\.0\.0\.1:\d+\/v1\/notifications\/unsubscribe\?token=[\w-]+\.[\w-]+>$/,
    );
    expect(mail?.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Read before it was due: no email.
    await staffReply(id, 'It should arrive tomorrow.');
    const head = await visitor.call('GET', `/v1/widget/conversations/${id}`);
    await visitor.call('POST', `/v1/widget/conversations/${id}/read`, {
      upToSequence: head.body.latestSequence,
    });
    await dueNow(REPLY_WAITING_TOPIC);
    expect(mails()).toHaveLength(1);
    // Unread, but the last email was less than 30 minutes ago: none either.
    await staffReply(id, 'The courier will call before delivery.');
    await dueNow(REPLY_WAITING_TOPIC);
    expect(mails()).toHaveLength(1);
    const outcomes = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({
          kind: schema.customerNotifications.kind,
          status: schema.customerNotifications.status,
          skipReason: schema.customerNotifications.skipReason,
        })
        .from(schema.customerNotifications)
        .where(eq(schema.customerNotifications.conversationId, fromPublicId('conversation', id))),
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        { kind: 'reply_waiting', status: 'sent', skipReason: null },
        { kind: 'reply_waiting', status: 'skipped', skipReason: 'read' },
        { kind: 'reply_waiting', status: 'skipped', skipReason: 'recently_notified' },
      ]),
    );
    expect(outcomes.filter((o) => o.status === 'sent')).toHaveLength(1);
  });

  it('sends a transcript without private notes when the conversation closes, once', async () => {
    await staffReply(id, 'Internal: VIP customer, waive the fee', true);
    const { externalConversationId } = await control(id);
    await asStaff('POST', `/conversations/${externalConversationId}/toggle_status`, {
      status: 'resolved',
    });
    await slice.drain();
    const transcripts = () => mails().filter((m) => m.template === 'customer.transcript');
    expect(transcripts()).toHaveLength(1);
    const transcript = transcripts()[0];
    expect(transcript?.text).toContain('Where is my parcel?');
    expect(transcript?.text).toContain('Your parcel left our warehouse today.');
    expect(transcript?.text).not.toContain('VIP');
    // Delivered again, the job sends nothing twice.
    const [queued] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.outboxEvents).where(eq(schema.outboxEvents.topic, TRANSCRIPT_TOPIC)),
    );
    expect(queued).toBeDefined();
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx.insert(schema.outboxEvents).values({
        tenantId,
        topic: TRANSCRIPT_TOPIC,
        aggregateType: 'conversation',
        aggregateId: queued?.aggregateId as string,
        payload: queued?.payload as Record<string, unknown>,
      }),
    );
    await slice.drain();
    expect(transcripts()).toHaveLength(1);
  });

  it('turns emails off from the link in them, asking first, and refuses altered links', async () => {
    const transcript = mails().find((m) => m.template === 'customer.transcript');
    const link = unsubscribeLink(transcript?.headers?.['List-Unsubscribe']);
    const page = await fetch(link);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<form method="post"');
    // Opening the link (as mail scanners do) changes nothing.
    expect((await visitor.call('GET', '/v1/widget/notifications')).body).toMatchObject({
      transcript: true,
      replyWaiting: true,
    });
    // The mail client's one-click unsubscribe (RFC 8058).
    const oneClick = await fetch(link, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.status).toBe(200);
    expect((await visitor.call('GET', '/v1/widget/notifications')).body).toMatchObject({
      transcript: false,
      replyWaiting: true,
    });
    const reply = mails().find((m) => m.template === 'customer.reply_waiting');
    const replyLink = unsubscribeLink(reply?.headers?.['List-Unsubscribe']);
    expect((await fetch(replyLink, { method: 'POST' })).status).toBe(200);
    expect((await visitor.call('GET', '/v1/widget/notifications')).body).toMatchObject({
      transcript: false,
      replyWaiting: false,
    });

    const altered = `${link.slice(0, -1)}${link.endsWith('A') ? 'B' : 'A'}`;
    expect((await fetch(altered)).status).toBe(404);
    expect((await fetch(altered, { method: 'POST' })).status).toBe(404);
    // A link for one kind of email cannot be turned into one for all of them.
    const token = new URL(link).searchParams.get('token') as string;
    const [payload, mac] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8'));
    const widened = Buffer.from(JSON.stringify({ ...claims, k: 'all' })).toString('base64url');
    const forged = `${slice.baseUrl}/v1/notifications/unsubscribe?token=${widened}.${mac}`;
    expect((await fetch(forged, { method: 'POST' })).status).toBe(404);
  });
});
