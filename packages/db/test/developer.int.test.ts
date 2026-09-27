import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimWebhookDeliveries,
  newId,
  purgeWebhookEvents,
  schema as s,
  type TenantTx,
  tenantInvoices,
  withTenant,
} from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness, pgCode } from './helpers.js';

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
});

afterAll(async () => {
  await h?.close();
});

const inTenant = <T>(tenant: SeededTenant, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: tenant.tenantId }, work);

async function newConversation(tenant: SeededTenant, ownerMode: 'AI_ACTIVE' | 'WAITING_HUMAN') {
  const id = newId();
  await inTenant(tenant, (tx) =>
    tx.insert(s.conversationControls).values({
      id,
      tenantId: tenant.tenantId,
      connectionId: tenant.connectionId,
      inboxId: tenant.inboxId,
      brandId: tenant.brandId,
      principalId: tenant.principalId,
      externalConversationId: Math.floor(Math.random() * 1e9),
      ownerMode,
      authorityStatus: 'pending',
    }),
  );
  return id;
}

let seq = 100;
async function journal(
  tenant: SeededTenant,
  conversationId: string,
  lane: 'customer' | 'staff',
  eventType: string,
  data: Record<string, unknown>,
  occurredAt = new Date(),
) {
  seq += 1;
  await inTenant(tenant, (tx) =>
    tx.insert(s.conversationJournal).values({
      tenantId: tenant.tenantId,
      conversationId,
      seq,
      lane,
      eventType,
      event: { type: eventType, occurredAt: occurredAt.toISOString(), data },
      expiresAt: new Date(Date.now() + 86_400_000),
    }),
  );
}

const message = (kind: string, text: string) => ({
  message: {
    sender: { kind, displayName: 'x' },
    visibility: 'public',
    parts: [{ type: 'text', text }],
  },
});

async function sources(tenant: SeededTenant) {
  return inTenant(tenant, (tx) =>
    tx
      .select({ payload: s.outboxEvents.payload })
      .from(s.outboxEvents)
      .where(eq(s.outboxEvents.topic, 'webhooks.source'))
      .orderBy(s.outboxEvents.createdAt),
  );
}

/** A field PostgreSQL attached to an error (detail, hint), also when Drizzle wrapped it. */
function pgField(error: unknown, field: 'detail' | 'hint'): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === 'string') return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

async function setEndpoint(tenant: SeededTenant, status: 'active' | 'disabled') {
  await inTenant(tenant, (tx) =>
    tx
      .update(s.webhookEndpoints)
      .set(
        status === 'active'
          ? { status, disabledReason: null, disabledAt: null }
          : { status, disabledReason: 'manual', disabledAt: new Date() },
      )
      .where(eq(s.webhookEndpoints.tenantId, tenant.tenantId)),
  );
}

describe('analytics projection and metering', () => {
  it('records each new conversation once, with its channel, and meters it', async () => {
    const id = await newConversation(a, 'AI_ACTIVE');
    const [metrics] = await inTenant(a, (tx) =>
      tx.select().from(s.conversationMetrics).where(eq(s.conversationMetrics.id, id)),
    );
    expect(metrics).toMatchObject({
      startedWith: 'ai',
      channel: 'Channel::Api',
      humanInvolved: false,
    });
    const usage = await inTenant(a, (tx) =>
      tx
        .select()
        .from(s.usageEntries)
        .where(eq(s.usageEntries.dedupeKey, `conversation:${id}`)),
    );
    expect(usage).toEqual([expect.objectContaining({ meter: 'conversations', quantity: 1 })]);
  });

  it('keeps first message, first response, handoff and resolution times from the journal', async () => {
    const id = await newConversation(a, 'AI_ACTIVE');
    const t0 = new Date('2026-09-20T10:00:00Z');
    // An AI greeting before the customer writes is not a response.
    await journal(a, id, 'customer', 'message.created', message('ai_agent', 'Hello'), t0);
    await journal(
      a,
      id,
      'customer',
      'message.created',
      message('customer', 'Where is my order?'),
      new Date(t0.getTime() + 60_000),
    );
    await journal(
      a,
      id,
      'customer',
      'message.created',
      message('ai_agent', 'Let me check.'),
      new Date(t0.getTime() + 90_000),
    );
    await inTenant(a, (tx) =>
      tx
        .update(s.conversationControls)
        .set({ ownerMode: 'WAITING_HUMAN', ownerReason: 'customer_request' })
        .where(eq(s.conversationControls.id, id)),
    );
    await journal(
      a,
      id,
      'customer',
      'message.created',
      message('human_agent', 'I am here.'),
      new Date(t0.getTime() + 300_000),
    );
    await journal(
      a,
      id,
      'customer',
      'conversation.resolved',
      { canReopen: true },
      new Date(t0.getTime() + 600_000),
    );
    const [metrics] = await inTenant(a, (tx) =>
      tx.select().from(s.conversationMetrics).where(eq(s.conversationMetrics.id, id)),
    );
    expect(metrics).toMatchObject({
      firstCustomerMessageAt: new Date(t0.getTime() + 60_000),
      firstResponseAt: new Date(t0.getTime() + 90_000),
      firstResponseBy: 'ai',
      firstHumanResponseAt: new Date(t0.getTime() + 300_000),
      handoffReason: 'customer_request',
      humanInvolved: true,
      resolvedBy: 'person',
      resolutionCount: 1,
    });
    expect(metrics?.handedOffAt).not.toBeNull();
  });

  it('counts a conversation the AI resolved alone as resolved by the AI', async () => {
    const id = await newConversation(a, 'AI_ACTIVE');
    await journal(a, id, 'customer', 'message.created', message('customer', 'Hi'));
    await journal(a, id, 'customer', 'message.created', message('ai_agent', 'Hello'));
    await journal(a, id, 'customer', 'conversation.resolved', { canReopen: true });
    await journal(a, id, 'customer', 'conversation.reopened', {});
    const [metrics] = await inTenant(a, (tx) =>
      tx.select().from(s.conversationMetrics).where(eq(s.conversationMetrics.id, id)),
    );
    expect(metrics).toMatchObject({ resolvedBy: 'ai', humanInvolved: false, reopenCount: 1 });
  });
});

describe('webhook sources', () => {
  it('writes nothing while the tenant has no active endpoint', async () => {
    const before = (await sources(b)).length;
    const id = await newConversation(b, 'AI_ACTIVE');
    await journal(b, id, 'customer', 'message.created', message('customer', 'Hi'));
    expect((await sources(b)).length).toBe(before);
  });

  it('announces customer-visible changes and never the staff lane', async () => {
    await setEndpoint(b, 'active');
    try {
      const id = await newConversation(b, 'AI_ACTIVE');
      await journal(b, id, 'customer', 'message.created', message('customer', 'Hi'));
      await journal(b, id, 'staff', 'message.created', {
        message: { sender: { kind: 'human_agent' }, visibility: 'internal', parts: [] },
      });
      await inTenant(b, (tx) =>
        tx
          .update(s.conversationControls)
          .set({
            ownerMode: 'HUMAN_ACTIVE',
            ownerReason: 'staff_takeover',
            ownerStaffId: b.staffMemberId,
          })
          .where(eq(s.conversationControls.id, id)),
      );
      const mine = (await sources(b))
        .map((row) => row.payload as Record<string, unknown>)
        .filter((payload) => payload.conversationId === id);
      expect(mine.map((p) => p.kind)).toEqual(['conversation_created', 'journal', 'ownership']);
      expect(mine.every((p) => p.lane === undefined || p.lane === 'customer')).toBe(true);
      expect(mine[2]).toMatchObject({
        from: 'AI_ACTIVE',
        to: 'HUMAN_ACTIVE',
        reason: 'staff_takeover',
        staffId: b.staffMemberId,
      });
    } finally {
      await setEndpoint(b, 'disabled');
    }
  });

  it('announces every change of state of orders and refunds', async () => {
    await setEndpoint(b, 'active');
    try {
      const [order] = await inTenant(b, (tx) => tx.select().from(s.orders).limit(1));
      if (!order) throw new Error('no seeded order');
      await inTenant(b, (tx) =>
        tx.update(s.orders).set({ state: 'cancel_requested' }).where(eq(s.orders.id, order.id)),
      );
      await inTenant(b, (tx) =>
        tx
          .update(s.orders)
          .set({ deliverySummary: 'no state change' })
          .where(eq(s.orders.id, order.id)),
      );
      const orderEvents = (await sources(b))
        .map((row) => row.payload as Record<string, unknown>)
        .filter((payload) => payload.kind === 'orders');
      expect(orderEvents).toEqual([
        expect.objectContaining({
          id: order.id,
          op: 'update',
          state: 'cancel_requested',
          previousState: 'confirmed',
        }),
      ]);
    } finally {
      await setEndpoint(b, 'disabled');
    }
  });
});

describe('plan limits in the database', () => {
  async function limits(tenant: SeededTenant, values: Record<string, number | null>) {
    await inTenant(tenant, (tx) =>
      tx
        .update(s.tenantEntitlements)
        .set({ limits: values })
        .where(eq(s.tenantEntitlements.tenantId, tenant.tenantId)),
    );
  }

  const invite = (tenant: SeededTenant, roleId: string) =>
    inTenant(tenant, (tx) =>
      tx.insert(s.invitations).values({
        tenantId: tenant.tenantId,
        email: `x-${randomBytes(4).toString('hex')}@example.com`,
        roleId,
        scopeType: 'tenant',
        tokenHash: randomBytes(32),
        invitedBy: tenant.staffMemberId,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    );

  it('refuses an invitation beyond the seats of the plan, with the numbers', async () => {
    const [role] = await inTenant(a, (tx) => tx.select().from(s.roleDefinitions).limit(1));
    if (!role) throw new Error('no role');
    // One active owner and one pending invitation are seeded: two seats in use.
    await limits(a, { seats: 3 });
    await invite(a, role.id);
    let caught: unknown;
    try {
      await invite(a, role.id);
    } catch (error) {
      caught = error;
    }
    expect(pgCode(caught)).toBe('HN402');
    expect(pgField(caught, 'detail')).toBe('seats');
    expect(JSON.parse(pgField(caught, 'hint') ?? '{}')).toEqual({ max: 3, used: 3 });
    await limits(a, { seats: null });
    await invite(a, role.id);
  });

  it('refuses a document version beyond the knowledge storage of the plan', async () => {
    const [document] = await inTenant(a, (tx) => tx.select().from(s.knowledgeDocuments).limit(1));
    if (!document) throw new Error('no document');
    await limits(a, { knowledgeStorageBytes: 100 });
    const version = (size: number, n: number) =>
      inTenant(a, (tx) =>
        tx.insert(s.documentVersions).values({
          tenantId: a.tenantId,
          documentId: document.id,
          version: n,
          mediaType: 'text/plain',
          byteSize: size,
          contentHash: randomBytes(32),
        }),
      );
    await version(60, 50);
    await expectPgError(version(1, 51), 'HN402');
    await limits(a, {});
    await version(1, 52);
  });
});

describe('webhook delivery lease', () => {
  async function pendingDelivery(
    tenant: SeededTenant,
    times: { expiresAt?: Date; createdAt?: Date } = {},
  ) {
    const [endpoint] = await inTenant(tenant, (tx) =>
      tx.select().from(s.webhookEndpoints).limit(1),
    );
    if (!endpoint) throw new Error('no endpoint');
    const eventId = newId();
    const deliveryId = newId();
    await inTenant(tenant, async (tx) => {
      await tx.insert(s.webhookEvents).values({
        id: eventId,
        tenantId: tenant.tenantId,
        type: 'webhook.test',
        sourceKey: `test:${eventId}`,
        body: '{}',
        occurredAt: new Date(),
        expiresAt: times.expiresAt ?? new Date(Date.now() + 86_400_000),
        ...(times.createdAt ? { createdAt: times.createdAt } : {}),
      });
      await tx.insert(s.webhookDeliveries).values({
        id: deliveryId,
        tenantId: tenant.tenantId,
        endpointId: endpoint.id,
        eventId,
        nextAttemptAt: new Date(Date.now() - 1000),
      });
    });
    return deliveryId;
  }

  it('leases due deliveries across tenants once, and skips suspended tenants', async () => {
    const one = await pendingDelivery(a);
    const two = await pendingDelivery(b);
    const first = await claimWebhookDeliveries(h.app, { limit: 50, leaseSeconds: 60 });
    expect(first.map((d) => d.id)).toEqual(expect.arrayContaining([one, two]));
    expect(await claimWebhookDeliveries(h.app, { limit: 50, leaseSeconds: 60 })).toEqual([]);

    const three = await pendingDelivery(b);
    await inTenant(b, (tx) =>
      tx.update(s.tenants).set({ status: 'suspended' }).where(eq(s.tenants.id, b.tenantId)),
    );
    try {
      const claimed = await claimWebhookDeliveries(h.app, { limit: 50, leaseSeconds: 60 });
      expect(claimed.map((d) => d.id)).not.toContain(three);
    } finally {
      await inTenant(b, (tx) =>
        tx.update(s.tenants).set({ status: 'active' }).where(eq(s.tenants.id, b.tenantId)),
      );
    }
  });

  it('clears expired event bodies and deletes old events with their deliveries', async () => {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const expired = await pendingDelivery(a, { expiresAt: dayAgo });
    const old = await pendingDelivery(a, {
      expiresAt: dayAgo,
      createdAt: new Date(Date.now() - 100 * 86_400_000),
    });
    const eventOf = async (deliveryId: string) => {
      const [row] = await inTenant(a, (tx) =>
        tx.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, deliveryId)),
      );
      return row?.eventId;
    };
    const expiredEvent = await eventOf(expired);
    const result = await purgeWebhookEvents(h.app, { keepDays: 90 });
    expect(result.cleared).toBeGreaterThanOrEqual(1);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const [event] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(s.webhookEvents)
        .where(eq(s.webhookEvents.id, expiredEvent ?? '')),
    );
    expect(event?.body).toBeNull();
    // The old event went, and its delivery with it (cascade).
    expect(await eventOf(old)).toBeUndefined();
    expect(await eventOf(expired)).toBe(expiredEvent);
  });
});

describe('platform billing tables', () => {
  it('lets the platform role manage plans and invoices, and the app role touch neither', async () => {
    await h.platform.insert(s.plans).values({
      key: `team-${randomBytes(3).toString('hex')}`,
      name: 'Team',
      currency: 'AED',
      priceMinor: 10_000n,
      limits: { conversations: 1000 },
    });
    await expectPgError(h.app.execute(sql`select * from plans`), '42501');
    await expectPgError(
      h.app.execute(
        sql`insert into plans (id, key, name, currency, price_minor, limits) values (gen_random_uuid(), 'x', 'X', 'AED', 1, '{}')`,
      ),
      '42501',
    );
    await expectPgError(h.platform.execute(sql`delete from plans`), '42501');
  });

  it('shows a tenant only its own issued invoices', async () => {
    const invoice = (tenant: SeededTenant, status: 'draft' | 'issued', period: string) =>
      h.platform.insert(s.invoices).values({
        tenantId: tenant.tenantId,
        number: `HV-${randomBytes(4).toString('hex')}`,
        periodKey: period,
        periodStart: new Date(`${period}-01T00:00:00Z`),
        periodEnd: new Date(`${period}-28T00:00:00Z`),
        planKey: 'team',
        planName: 'Team',
        status,
        currency: 'AED',
        subtotalMinor: 10_000n,
        totalMinor: 10_000n,
        lines: [],
        usage: {},
        createdBy: 'test',
        ...(status === 'issued'
          ? { issuedAt: new Date(), dueAt: new Date(Date.now() + 14 * 86_400_000) }
          : {}),
      });
    await invoice(a, 'issued', '2026-07');
    await invoice(a, 'draft', '2026-08');
    await invoice(b, 'issued', '2026-07');
    const mine = await inTenant(a, (tx) => tenantInvoices(tx));
    expect(mine.map((i) => [i.periodKey, i.status])).toEqual([['2026-07', 'issued']]);
    expect(mine[0]?.totalMinor).toBe(10_000n);
    // Without a tenant in the transaction, nothing.
    expect(await h.app.transaction((tx) => tenantInvoices(tx as unknown as TenantTx))).toEqual([]);
    await expectPgError(
      h.platform.execute(
        sql`update invoices set status = 'paid' where tenant_id = ${a.tenantId}::uuid and status = 'issued'`,
      ),
      '23514',
    );
    const drafts = await h.platform
      .select()
      .from(s.invoices)
      .where(and(eq(s.invoices.tenantId, a.tenantId), eq(s.invoices.status, 'draft')));
    expect(drafts).toHaveLength(1);
  });
});
