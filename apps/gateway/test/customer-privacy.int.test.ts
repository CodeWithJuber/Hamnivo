import { randomUUID } from 'node:crypto';
import type { ClaimedOutboxEvent } from '@hamnivo/db';
import { fromPublicId, purgePrivacyFiles, schema, withTenant } from '@hamnivo/db';
import { readZip, utf8 } from '@hamnivo/migration-sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { importerFor } from '../src/migration/destination.js';
import { IdentityFingerprints } from '../src/privacy/identity-fingerprints.js';
import { PrivacyWorker } from '../src/privacy/privacy-worker.service.js';
import { enrolTotp } from './access-support.js';
import type { Client } from './harness.js';
import { customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * One customer's data on request (A10, ADR 0018): find a customer, download everything about
 * them as they saw it, or erase them everywhere, Chatwoot included. Owners and administrators,
 * for the brands they reach; erasing needs two-step verification.
 */

let slice: Slice;
let shop: Shop;
let tenantId: string;
let owner: Client;

const BASE = '/v1/admin/privacy';

/** A customer who chatted, with a name staff can find them by, and an internal note about them. */
async function customerNamed(name: string) {
  const { visitor, conversationId } = await customerStarts(slice, shop, `Hello, I am ${name}`);
  await slice.drain();
  const note = await shop.owner.post(`/v1/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    text: `Internal: ${name} was rude on the phone`,
    visibility: 'internal',
  });
  expect(note.status, JSON.stringify(note.body)).toBe(202);
  await slice.drain();
  const [control] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  if (!control?.principalId) throw new Error('no customer');
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.customerPrincipals)
      .set({ displayName: name })
      .where(eq(schema.customerPrincipals.id, control.principalId as string)),
  );
  const customerId = (await owner.get(`${BASE}/customers?query=${encodeURIComponent(name)}`)).body
    .items[0]?.id as string;
  return { visitor, conversationId, control, customerId };
}

async function requestRow(id: string) {
  const read = await owner.get(`${BASE}/requests/${id}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body;
}

const chatwoot = async (connectionId: string) =>
  importerFor(
    await slice.worker.get(AuthorityRegistry).get(tenantId, connectionId),
    slice.gw.config,
  );

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'customer-privacy');
  tenantId = fromPublicId('tenant', shop.tenantId);
  owner = (await enrolTotp(slice.gw, shop.owner, 'customer-privacy-owner@example.com')).client;
});

afterAll(async () => {
  await slice?.close();
});

describe('finding a customer (A10)', () => {
  it('works in the brands one may handle, for those who may', async () => {
    const { customerId, conversationId } = await customerNamed('Fatima Noor');
    expect(customerId).toMatch(/^cus_/);
    const found = await owner.get(`${BASE}/customers?query=fatima`);
    expect(found.body.items).toHaveLength(1);
    expect(found.body.items[0]).toMatchObject({ name: 'Fatima Noor', erasedAt: null });

    // Staff can paste a customer or conversation ID, for visitors who never gave a name.
    for (const id of [customerId, conversationId]) {
      const byId = await owner.get(`${BASE}/customers?query=${id}`);
      expect(byId.body.items.map((c: { id: string }) => c.id)).toEqual([customerId]);
    }

    const summary = await owner.get(`${BASE}/customers/${customerId}`);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body).toMatchObject({ conversations: 1, orders: 0, sharedContact: false });

    const agent = await join(slice, shop, 'Ali Agent', 'agent');
    expect((await agent.client.get(`${BASE}/customers?query=fatima`)).status).toBe(403);
    expect((await owner.get(`${BASE}/customers?query=f`)).status).toBe(422);
  });
});

describe('exporting a customer (A10)', () => {
  it('gives a file with what the customer saw, kept 24 hours, and audits each download', async () => {
    const { customerId } = await customerNamed('Yusuf Khan');
    const asked = await owner.post(`${BASE}/customers/${customerId}/export`, {
      reason: 'access_request',
      reference: 'Ticket 42',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    expect(asked.body).toMatchObject({ kind: 'export', state: 'queued', customerId });
    await slice.drain();

    const done = await requestRow(asked.body.id);
    expect(done).toMatchObject({ state: 'completed', reference: 'Ticket 42' });
    expect(done.counts).toMatchObject({ conversations: 1 });
    expect(done.file.byteSize).toBeGreaterThan(0);

    const download = await owner.get(`${BASE}/requests/${asked.body.id}/file`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toBe('application/zip');
    const [file] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.privacyFiles)
        .where(eq(schema.privacyFiles.requestId, fromPublicId('privacyRequest', asked.body.id))),
    );
    const zip = readZip(file?.raw as Buffer);
    expect([...zip.keys()]).toEqual(
      expect.arrayContaining([
        'customer.json',
        'consents.json',
        'memory.json',
        'orders.json',
        'manifest.json',
        'README.txt',
      ]),
    );
    expect(JSON.parse(utf8(zip.get('customer.json') as Uint8Array))).toMatchObject({
      id: customerId,
      name: 'Yusuf Khan',
    });
    const conversations = [...zip.keys()].filter((k) => k.startsWith('conversations/'));
    expect(conversations).toHaveLength(1);
    const text = utf8(zip.get(conversations[0] as string) as Uint8Array);
    expect(text).toContain('Hello, I am Yusuf Khan');
    // Internal notes are not the customer's to see.
    expect(text).not.toContain('rude on the phone');
    const manifest = JSON.parse(utf8(zip.get('manifest.json') as Uint8Array));
    expect(manifest.files.map((f: { path: string }) => f.path)).toContain('customer.json');

    const audit = await owner.get('/v1/admin/audit?action=privacy.export_downloaded');
    expect(audit.body.items[0]?.target.id).toBe(customerId);
    // The requester is told it is ready.
    expect(slice.workerMailer.messages.some((m) => m.template === 'privacy.export_ready')).toBe(
      true,
    );

    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.privacyFiles)
        .set({ purgeAfter: new Date(Date.now() - 1000) })
        .where(eq(schema.privacyFiles.requestId, fromPublicId('privacyRequest', asked.body.id))),
    );
    await purgePrivacyFiles(slice.app);
    expect((await owner.get(`${BASE}/requests/${asked.body.id}/file`)).status).toBe(404);
    expect((await requestRow(asked.body.id)).file).toBeNull();
  });
});

describe('erasing a customer (A10)', () => {
  it('needs two-step verification and the customer’s ID typed again', async () => {
    const { customerId } = await customerNamed('Omar Saleh');
    const admin = await join(slice, shop, 'Sara Admin', 'admin');
    const unverified = await admin.client.post(`${BASE}/customers/${customerId}/erase`, {
      confirm: customerId,
    });
    expect(unverified.status).toBe(401);
    expect(unverified.body.code).toBe('MFA_REQUIRED');
    // An administrator may export.
    expect((await admin.client.post(`${BASE}/customers/${customerId}/export`, {})).status).toBe(
      202,
    );

    const typo = await owner.post(`${BASE}/customers/${customerId}/erase`, {
      confirm: 'cus_wrong',
    });
    expect(typo.status).toBe(422);
  });

  it('deletes the customer everywhere, Chatwoot included, and remembers it', async () => {
    const { customerId, control } = await customerNamed('Layla Hassan');
    const [link] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.authorityContacts)
        .where(eq(schema.authorityContacts.principalId, control.principalId as string)),
    );
    const contactId = link?.externalContactId as number;
    expect(contactId).toBeTypeOf('number');

    const asked = await owner.post(`${BASE}/customers/${customerId}/erase`, {
      confirm: customerId,
      reason: 'erasure_request',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(202);
    await slice.drain();
    const done = await requestRow(asked.body.id);
    expect(done.state, JSON.stringify(done)).toBe('completed');
    expect(done.counts).toMatchObject({
      chatwootConversations: 1,
      chatwootContacts: 1,
      conversations: 1,
      customerDeleted: 1,
    });

    const api = await chatwoot(control.connectionId);
    expect(await api.getConversation(control.externalConversationId)).toBeNull();
    expect(await api.getContact(contactId)).toBeNull();
    expect((await owner.get(`${BASE}/customers/${customerId}`)).status).toBe(404);
    expect((await owner.get(`${BASE}/customers?query=layla`)).body.items).toEqual([]);
    // Reports keep the conversation's numbers.
    const [metrics] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationMetrics)
        .where(eq(schema.conversationMetrics.id, control.id)),
    );
    expect(metrics?.retiredAt).toBeInstanceOf(Date);
    const [tombstone] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.erasureTombstones)
        .where(eq(schema.erasureTombstones.principalId, control.principalId as string)),
    );
    expect(tombstone?.authority.contacts).toEqual([
      { connectionId: control.connectionId, id: contactId },
    ]);
    expect(tombstone?.fingerprints.length).toBeGreaterThan(0);
    const audit = await owner.get('/v1/admin/audit?action=privacy.erased');
    expect(audit.body.items[0]?.target.id).toBe(customerId);
  });

  it('stops when Chatwoot refuses, deleting nothing here, and can be asked again', async () => {
    const { customerId, control } = await customerNamed('Bilal Ahmed');
    slice.fake.setRequestFault((method) => (method === 'DELETE' ? 403 : null));
    let first: { id: string };
    try {
      first = (await owner.post(`${BASE}/customers/${customerId}/erase`, { confirm: customerId }))
        .body;
      await slice.drain();
    } finally {
      slice.fake.setRequestFault(null);
    }
    expect(await requestRow(first.id)).toMatchObject({
      state: 'blocked',
      problem: 'authority_not_admin',
    });
    const [still] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.customerPrincipals)
        .where(eq(schema.customerPrincipals.id, control.principalId as string)),
    );
    expect(still).toBeDefined();

    const again = await owner.post(`${BASE}/customers/${customerId}/erase`, {
      confirm: customerId,
    });
    expect(again.body.id).not.toBe(first.id);
    await slice.drain();
    expect((await requestRow(again.body.id)).state).toBe('completed');
  });

  it('after a restore, deletes a Chatwoot contact again only while it is still the same person', async () => {
    const [connection] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select().from(schema.authorityConnections),
    );
    const connectionId = connection?.id as string;
    const api = await chatwoot(connectionId);
    const inboxId = shop.connection.inboxes[0]?.externalInboxId as number;
    const same = await api.createContact({
      inboxId,
      identifier: `restored-${randomUUID()}`,
      name: 'Restored person',
      attributes: {},
    });
    const other = await api.createContact({
      inboxId,
      identifier: `someone-else-${randomUUID()}`,
      name: 'Someone else',
      attributes: {},
    });
    const sameProfile = await api.getContact(same.contactId);
    const brandId = fromPublicId('brand', shop.brand.id);
    const fingerprints = slice.worker
      .get(IdentityFingerprints)
      .current({ tenantId, brandId }, { identifier: sameProfile?.identifier ?? null });
    const requestId = randomUUID();
    const tombstoneId = randomUUID();
    await withTenant(slice.app, { tenantId }, async (tx) => {
      await tx.insert(schema.privacyRequests).values({
        id: requestId,
        tenantId,
        kind: 'erase',
        brandId,
        principalId: randomUUID(),
        state: 'completed',
        reason: 'erasure_request',
      });
      await tx.insert(schema.erasureTombstones).values({
        id: tombstoneId,
        tenantId,
        requestId,
        brandId,
        principalId: randomUUID(),
        // The second id now belongs to someone else, as after a restore that reused it.
        authority: {
          contacts: [
            { connectionId, id: same.contactId },
            { connectionId, id: other.contactId },
          ],
          conversations: [],
        },
        fingerprints,
      });
    });
    await slice.worker.get(PrivacyWorker).onReplay({
      id: randomUUID(),
      tenantId,
      topic: 'privacy.replay',
      payload: { tombstoneId },
    } as unknown as ClaimedOutboxEvent);
    expect(await api.getContact(same.contactId)).toBeNull();
    expect(await api.getContact(other.contactId)).not.toBeNull();
  });
});
