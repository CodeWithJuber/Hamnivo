import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { importerFor } from '../src/migration/destination.js';
import { RetentionSweep } from '../src/privacy/retention-sweep.service.js';
import { enrolTotp } from './access-support.js';
import type { Client } from './harness.js';
import { customerStarts, join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Retention (A10, ADR 0017): an owner sets how long resolved conversations are kept. Turning it on
 * waits a grace period; the worker's sweep then deletes old resolved conversations in Chatwoot and
 * in Hamnivo, history only Chatwoot has, and customers left with nothing. Reports stay the same.
 * Ages are moved back in the database and in the fake Chatwoot, whose clocks the sweep reads.
 */

let slice: Slice;
let shop: Shop;
let tenantId: string;
let owner: Client;
let sweep: RetentionSweep;

const PATH = '/v1/admin/privacy/retention';
const DAY_HOURS = 24;

async function setDays(days: number | null) {
  // Straight into force, without the grace (which the API tests on their own).
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .insert(schema.retentionPolicies)
      .values({ tenantId, conversationDays: days })
      .onConflictDoUpdate({
        target: schema.retentionPolicies.tenantId,
        set: { conversationDays: days, pendingDays: null, pendingFrom: null, sweptAt: null },
      }),
  );
}

async function control(conversationId: string) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.conversationControls)
      .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId))),
  );
  return row;
}

/** A customer's conversation, resolved by the owner. */
async function resolvedChat(text: string) {
  const started = await customerStarts(slice, shop, text);
  await slice.drain();
  const closed = await shop.owner.post(`/v1/inbox/conversations/${started.conversationId}/status`, {
    status: 'resolved',
  });
  expect(closed.status, JSON.stringify(closed.body)).toBe(200);
  await slice.drain();
  return started;
}

/** Moves a conversation's last activity back, here and (unless told not to) in Chatwoot. */
async function age(conversationId: string, days: number, inChatwoot = true) {
  const row = await control(conversationId);
  if (!row) throw new Error('no conversation');
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.conversationControls)
      .set({ lastActivityAt: sql`now() - make_interval(days => ${days}::int)` })
      .where(eq(schema.conversationControls.id, row.id)),
  );
  if (inChatwoot) slice.fake.ageConversation(row.externalConversationId, days * DAY_HOURS);
  return row;
}

async function policyRow() {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx.select().from(schema.retentionPolicies),
  );
  return row;
}

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
async function overview() {
  const report = await shop.owner.get(
    `/v1/admin/analytics/overview?from=${weekAgo()}&to=${today()}&brandId=${shop.brand.id}`,
  );
  expect(report.status, JSON.stringify(report.body)).toBe(200);
  const { generatedAt: _, ...rest } = report.body;
  return rest;
}

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'retention');
  tenantId = fromPublicId('tenant', shop.tenantId);
  owner = (await enrolTotp(slice.gw, shop.owner, 'retention-owner@example.com')).client;
  sweep = slice.worker.get(RetentionSweep);
});

afterAll(async () => {
  await slice?.close();
});

describe('retention settings (A10)', () => {
  it('belong to owners who passed two-step verification', async () => {
    const agent = await join(slice, shop, 'Ali Agent', 'agent');
    const admin = await join(slice, shop, 'Sara Admin', 'admin');
    expect((await agent.client.get(PATH)).status).toBe(403);
    expect((await admin.client.get(PATH)).status).toBe(403);
    const second = await join(slice, shop, 'Bilal Owner', 'owner');
    const unverified = await second.client.get(PATH);
    expect(unverified.status).toBe(401);
    expect(unverified.body.code).toBe('MFA_REQUIRED');

    const read = await owner.get(PATH);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      conversationDays: null,
      pending: null,
      choices: [90, 180, 365, 730, 1095, 1825, 2555],
      graceDays: 7,
      version: 0,
      sweep: { state: 'idle', conversationsDeleted: 0, customersDeleted: 0 },
    });
    expect((await owner.put(PATH, { conversationDays: 100, version: 0 })).status).toBe(422);
  });

  it('wait out a grace before deleting sooner, can be undone, and tell every owner', async () => {
    const saved = await owner.put(PATH, { conversationDays: 365, version: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.conversationDays).toBeNull();
    expect(saved.body.pending.conversationDays).toBe(365);
    const waits = new Date(saved.body.pending.from).getTime() - Date.now();
    expect(waits).toBeGreaterThan(6.9 * 86_400_000);
    expect(saved.body.version).toBe(1);

    // Every owner hears, the one who changed it too.
    const mails = slice.gw.mailer.messages.filter(
      (m) => m.template === 'privacy.retention_changed',
    );
    expect(mails.map((m) => m.to)).toContain('retention-owner@example.com');
    expect(mails).toHaveLength(2);
    const mail = mails[0];
    expect(mail?.text).toContain('1 year');
    expect(mail?.text).toContain('undo');

    expect((await owner.put(PATH, { conversationDays: null, version: 0 })).status).toBe(409);
    const undone = await owner.put(PATH, { conversationDays: null, version: 1 });
    expect(undone.body).toMatchObject({ conversationDays: null, pending: null, version: 2 });

    const audit = await owner.get('/v1/admin/audit?action=privacy.retention_changed');
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    expect(audit.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('preview what a period would delete', async () => {
    const chat = await resolvedChat('An old question about sizes');
    await age(chat.conversationId, 200);
    const preview = await owner.get(`${PATH}/preview?days=180`);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.conversations).toBeGreaterThanOrEqual(1);
    expect(preview.body.oldestActivityAt).not.toBeNull();
    expect(new Date(preview.body.deletesFrom).getTime()).toBeGreaterThan(Date.now());
    expect((await owner.get(`${PATH}/preview?days=365`)).body.conversations).toBe(0);
  });
});

describe('the retention sweep (A10)', () => {
  it('deletes old resolved conversations in Chatwoot and in Hamnivo, and reports stay the same', async () => {
    const old = await resolvedChat('Where is my parcel?');
    // A rated ticket: both are counted by reports, from records the conversation takes with it.
    const ticket = await shop.owner.post(`/v1/inbox/conversations/${old.conversationId}/ticket`, {
      priority: 'high',
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(200);
    const rated = await old.visitor.call(
      'POST',
      `/v1/widget/conversations/${old.conversationId}/feedback`,
      { rating: 4 },
    );
    expect(rated.status, JSON.stringify(rated.body)).toBe(204);
    await slice.drain();
    const recent = await resolvedChat('Do you ship to Medina?');
    const busy = await resolvedChat('Is the blue one in stock?');
    const oldRow = await age(old.conversationId, 400);
    await age(recent.conversationId, 10);
    // Old here, but Chatwoot saw activity since: Chatwoot is the record, so it stays.
    await age(busy.conversationId, 400, false);
    await setDays(365);
    const before = await overview();
    const chatwootBefore = slice.fake.snapshot(shop.connection.accountId).conversations;

    const done = await sweep.run();
    expect(done.conversations).toBeGreaterThanOrEqual(1);

    expect(await control(old.conversationId)).toBeUndefined();
    expect(await control(recent.conversationId)).toBeDefined();
    expect(await control(busy.conversationId)).toBeDefined();
    expect(slice.fake.snapshot(shop.connection.accountId).conversations).toBe(chatwootBefore - 1);
    const runtime = await slice.worker.get(AuthorityRegistry).get(tenantId, oldRow.connectionId);
    const chatwoot = importerFor(runtime, slice.gw.config);
    expect(await chatwoot.getConversation(oldRow.externalConversationId)).toBeNull();

    // What reports count stays: the conversation's report row outlives it.
    expect(await overview()).toEqual(before);
    const [metrics] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationMetrics)
        .where(eq(schema.conversationMetrics.id, oldRow.id)),
    );
    expect(metrics?.retiredAt).toBeInstanceOf(Date);

    const policy = await policyRow();
    expect(policy?.conversationsDeleted).toBeGreaterThanOrEqual(1);
    expect(policy?.sweepState).toBe('idle');
    const audit = await owner.get('/v1/admin/audit?action=privacy.retention_swept');
    expect(audit.body.items[0]?.data.ids).toContain(old.conversationId);
  });

  it('stops for the workspace, deleting nothing, when Chatwoot refuses to delete', async () => {
    const chat = await resolvedChat('A question from long ago');
    await age(chat.conversationId, 400);
    slice.fake.setRequestFault((method) => (method === 'DELETE' ? 403 : null));
    try {
      await sweep.run();
    } finally {
      slice.fake.setRequestFault(null);
    }
    expect(await control(chat.conversationId)).toBeDefined();
    expect((await policyRow())?.sweepState).toBe('blocked');
    const read = await owner.get(PATH);
    expect(read.body.sweep.state).toBe('blocked');

    await sweep.run();
    expect(await control(chat.conversationId)).toBeUndefined();
    expect((await policyRow())?.sweepState).toBe('idle');
  });

  it('deletes old history only Chatwoot has, in this workspace', async () => {
    const [connection] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx.select({ id: schema.authorityConnections.id }).from(schema.authorityConnections),
    );
    const runtime = await slice.worker
      .get(AuthorityRegistry)
      .get(tenantId, connection?.id as string);
    const chatwoot = importerFor(runtime, slice.gw.config);
    const inboxId = shop.connection.inboxes[0]?.externalInboxId as number;
    // Imported before Hamnivo: Hamnivo never hears of it.
    slice.fake.setChaos({ drop: 1 });
    let conversationId: number;
    try {
      const { contactId, contactInboxSourceId } = await chatwoot.createContact({
        inboxId,
        identifier: `old-${randomUUID()}`,
        name: 'Old visitor',
        attributes: {},
      });
      ({ conversationId } = await chatwoot.createConversation({
        inboxId,
        contactId,
        contactInboxSourceId,
        key: randomUUID(),
        attributes: {},
      }));
      await chatwoot.resolve(conversationId);
      await slice.fake.flush();
    } finally {
      slice.fake.setChaos({ drop: 0 });
    }
    slice.fake.ageConversation(conversationId, 500 * DAY_HOURS);
    await setDays(365);

    await sweep.run();
    expect(await chatwoot.getConversation(conversationId)).toBeNull();
  });

  it('removes customers left with nothing, with their Chatwoot contact', async () => {
    const chat = await resolvedChat('One last question');
    const row = await age(chat.conversationId, 400);
    await setDays(365);
    await sweep.run();
    expect(await control(chat.conversationId)).toBeUndefined();
    const principalId = row.principalId as string;
    const [link] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.authorityContacts)
        .where(eq(schema.authorityContacts.principalId, principalId)),
    );
    expect(link?.externalContactId).toBeTypeOf('number');

    // Still in their session and seen today: they stay.
    await setDays(365);
    await sweep.run();
    expect(await customer(principalId)).toBeDefined();

    await withTenant(slice.app, { tenantId }, async (tx) => {
      await tx
        .update(schema.customerPrincipals)
        .set({
          lastSeenAt: sql`now() - interval '400 days'`,
          createdAt: sql`now() - interval '400 days'`,
        })
        .where(eq(schema.customerPrincipals.id, principalId));
      await tx
        .update(schema.widgetSessions)
        .set({ revokedAt: new Date() })
        .where(eq(schema.widgetSessions.principalId, principalId));
    });
    await setDays(365);
    await sweep.run();
    expect(await customer(principalId)).toBeUndefined();
    const runtime = await slice.worker.get(AuthorityRegistry).get(tenantId, row.connectionId);
    expect(
      await importerFor(runtime, slice.gw.config).getContact(link?.externalContactId as number),
    ).toBeNull();
    expect((await policyRow())?.customersDeleted).toBeGreaterThanOrEqual(1);
  });

  it('leaves workspaces that keep everything alone', async () => {
    const other = await connectedTenant(slice, 'retention-other');
    const otherTenant = fromPublicId('tenant', other.tenantId);
    const started = await customerStarts(slice, other, 'Salaam');
    await slice.drain();
    await withTenant(slice.app, { tenantId: otherTenant }, (tx) =>
      tx
        .update(schema.conversationControls)
        .set({
          authorityStatus: 'resolved',
          lastActivityAt: sql`now() - interval '4000 days'`,
        })
        .where(
          and(
            eq(
              schema.conversationControls.id,
              fromPublicId('conversation', started.conversationId),
            ),
          ),
        ),
    );
    await sweep.run();
    const [kept] = await withTenant(slice.app, { tenantId: otherTenant }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(
          eq(schema.conversationControls.id, fromPublicId('conversation', started.conversationId)),
        ),
    );
    expect(kept).toBeDefined();
  });
});

async function customer(principalId: string) {
  const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select()
      .from(schema.customerPrincipals)
      .where(eq(schema.customerPrincipals.id, principalId)),
  );
  return row;
}
