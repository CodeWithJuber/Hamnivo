import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyErasureTombstones,
  eraseCustomer,
  newId,
  purgePrivacyFiles,
  schema,
  type TenantTx,
  withTenant,
} from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

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

const inTenant = <T>(t: SeededTenant, work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: t.tenantId }, work);

async function request(
  t: SeededTenant,
  principalId: string,
  kind: 'export' | 'erase' = 'erase',
  state: 'queued' | 'running' | 'completed' | 'blocked' = 'running',
) {
  const id = newId();
  await inTenant(t, (tx) =>
    tx.insert(schema.privacyRequests).values({
      id,
      tenantId: t.tenantId,
      kind,
      brandId: t.brandId,
      principalId,
      state,
      reason: kind === 'erase' ? 'erasure_request' : 'access_request',
    }),
  );
  return id;
}

async function customer(t: SeededTenant, id: string) {
  const [row] = await inTenant(t, (tx) =>
    tx.select().from(schema.customerPrincipals).where(eq(schema.customerPrincipals.id, id)),
  );
  return row;
}

/** A customer with no conversation and nothing bought: a visitor who only opened the widget. */
async function visitorOnly(t: SeededTenant) {
  const id = newId();
  await inTenant(t, async (tx) => {
    await tx.insert(schema.customerPrincipals).values({
      id,
      tenantId: t.tenantId,
      brandId: t.brandId,
      kind: 'verified',
      externalSubject: `user-${id}`,
      displayName: 'Maryam',
      email: `maryam-${id}@example.com`,
    });
    await tx.insert(schema.languagePreferences).values({
      tenantId: t.tenantId,
      principalId: id,
      explicitLanguage: 'ar',
    });
  });
  return id;
}

describe('erasing one customer (A10)', () => {
  it('refuses without a tenant, for another tenant, and for anything but a running erasure', async () => {
    const running = await request(a, a.principalId);
    await expectPgError(h.app.execute(sql`select app.erase_customer(${running}::uuid)`), '42501');
    await expectPgError(
      inTenant(b, (tx) => eraseCustomer(tx, running)),
      '23514',
    );
    const exporting = await request(a, a.principalId, 'export');
    await expectPgError(
      inTenant(a, (tx) => eraseCustomer(tx, exporting)),
      '23514',
    );
    const queued = await request(a, a.principalId, 'erase', 'queued');
    await expectPgError(
      inTenant(a, (tx) => eraseCustomer(tx, queued)),
      '23514',
    );
    expect(await customer(a, a.principalId)).toBeDefined();
  });

  it('waits for their memory to be deleted first', async () => {
    const id = await request(a, a.principalId);
    const result = await inTenant(a, (tx) => eraseCustomer(tx, id));
    expect(result).toEqual({ conversations: 0, customer: 'memory_left' });
    expect((await customer(a, a.principalId))?.displayName).not.toBeNull();
  });

  it('erases their conversations and records, and keeps a buyer as an anonymous stub', async () => {
    await inTenant(a, async (tx) => {
      // What the memory deletion path does before an erasure.
      await tx.execute(
        sql`delete from memory_embeddings where memory_id in (select id from memory_records where subject_id = ${a.principalId}::uuid)`,
      );
      await tx
        .delete(schema.memoryRecords)
        .where(eq(schema.memoryRecords.subjectId, a.principalId));
    });
    const id = await request(a, a.principalId);
    const result = await inTenant(a, (tx) => eraseCustomer(tx, id));
    expect(result.customer).toBe('anonymised');
    expect(result.conversations).toBeGreaterThanOrEqual(1);

    const stub = await customer(a, a.principalId);
    expect(stub).toMatchObject({
      kind: 'anonymous',
      externalSubject: null,
      displayName: null,
      email: null,
      channelHandle: null,
      locale: null,
    });
    expect(stub?.erasedAt).toBeInstanceOf(Date);
    const [conversation] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.principalId, a.principalId)),
    );
    expect(conversation).toBeUndefined();
    const [order] = await inTenant(a, (tx) =>
      tx.select().from(schema.orders).where(eq(schema.orders.principalId, a.principalId)),
    );
    expect(order).toBeDefined();
    expect(order?.deliverySummary).toBeNull();
    const sessions = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.widgetSessions)
        .where(eq(schema.widgetSessions.principalId, a.principalId)),
    );
    expect(sessions).toEqual([]);
    expect(await inTenant(a, (tx) => tx.select().from(schema.workflowRuns))).toEqual([]);
    expect(await inTenant(a, (tx) => tx.select().from(schema.workflowRunSteps))).toEqual([]);
    expect(await inTenant(a, (tx) => tx.select().from(schema.connectorQuotes))).toEqual([]);
    expect(await inTenant(a, (tx) => tx.select().from(schema.connectorIdentityBindings))).toEqual(
      [],
    );
    const [fence] = await inTenant(a, (tx) => tx.select().from(schema.connectorDispatches));
    expect(fence).toMatchObject({
      principalId: null,
      state: 'confirmed',
      idempotencyKey: expect.stringMatching(/^dispatch-/),
    });
    expect(
      await inTenant(b, (tx) => tx.select().from(schema.connectorIdentityBindings)),
    ).toHaveLength(1);
    expect(await inTenant(b, (tx) => tx.select().from(schema.workflowRuns))).toHaveLength(1);
    // The other tenant's customer is untouched.
    expect((await customer(b, b.principalId))?.displayName).not.toBeNull();
  });

  it('deletes a customer who bought nothing', async () => {
    const id = await visitorOnly(a);
    const dispatchId = newId();
    await inTenant(a, async (tx) => {
      const [connection] = await tx.select().from(schema.connectorConnections);
      await tx.insert(schema.connectorIdentityBindings).values({
        tenantId: a.tenantId,
        brandId: a.brandId,
        connectionId: connection!.id,
        principalId: id,
        userId: 701,
        clientId: 702,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await tx.insert(schema.connectorQuotes).values({
        tenantId: a.tenantId,
        connectionId: connection!.id,
        principalId: id,
        conversationId: newId(),
        fingerprint: 'private-quote',
        price: '15.00',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await tx.insert(schema.connectorDispatches).values({
        id: dispatchId,
        tenantId: a.tenantId,
        connectionId: connection!.id,
        principalId: id,
        fingerprint: 'opaque-unknown-fence',
        idempotencyKey: 'erased-unknown-write',
        state: 'dispatched',
      });
    });
    const result = await inTenant(a, async (tx) => eraseCustomer(tx, await request(a, id)));
    expect(result).toEqual({ conversations: 0, customer: 'deleted' });
    expect(await customer(a, id)).toBeUndefined();
    expect(await inTenant(a, (tx) => tx.select().from(schema.connectorQuotes))).toEqual([]);
    expect(await inTenant(a, (tx) => tx.select().from(schema.connectorIdentityBindings))).toEqual(
      [],
    );
    const [fence] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.connectorDispatches)
        .where(eq(schema.connectorDispatches.id, dispatchId)),
    );
    expect(fence).toMatchObject({
      principalId: null,
      state: 'dispatched',
      fingerprint: 'opaque-unknown-fence',
    });
    // A retained idempotency key still rejects re-insertion after customer erasure.
    await expectPgError(
      inTenant(a, (tx) =>
        tx.insert(schema.connectorDispatches).values({
          ...fence!,
          id: newId(),
        }),
      ),
      '23505',
    );
  });

  it('erases again a customer a restore brought back, once their erasure finished', async () => {
    const tombstone = async (state: 'running' | 'blocked' | 'completed') => {
      const id = await visitorOnly(a);
      const erasure = await request(a, id, 'erase', state);
      await inTenant(a, (tx) =>
        tx.insert(schema.erasureTombstones).values({
          tenantId: a.tenantId,
          requestId: erasure,
          brandId: a.brandId,
          principalId: id,
        }),
      );
      return { id, erasure };
    };
    // The tombstone is written before Chatwoot is asked: an erasure still running, or one
    // Chatwoot refused, is not finished here behind the worker's back.
    const running = await tombstone('running');
    const blocked = await tombstone('blocked');
    const { id, erasure } = await tombstone('completed');
    expect(await applyErasureTombstones(h.app)).toBeGreaterThanOrEqual(1);
    expect(await customer(a, id)).toBeUndefined();
    expect(await customer(a, running.id)).toBeDefined();
    expect(await customer(a, blocked.id)).toBeDefined();
    // Tombstones stay as they are.
    await expectPgError(
      inTenant(a, (tx) =>
        tx.delete(schema.erasureTombstones).where(eq(schema.erasureTombstones.requestId, erasure)),
      ),
      '42501',
    );
  });

  it('clears an export file’s bytes after 24 hours', async () => {
    const id = await request(a, a.principalId, 'export');
    await inTenant(a, (tx) =>
      tx.insert(schema.privacyFiles).values({
        tenantId: a.tenantId,
        requestId: id,
        raw: Buffer.from('PK'),
        sha256: 'x'.repeat(64),
        byteSize: 2,
        purgeAfter: new Date(Date.now() - 1000),
      }),
    );
    expect(await purgePrivacyFiles(h.app)).toBeGreaterThanOrEqual(1);
    const [file] = await inTenant(a, (tx) =>
      tx
        .select()
        .from(schema.privacyFiles)
        .where(
          and(eq(schema.privacyFiles.tenantId, a.tenantId), eq(schema.privacyFiles.requestId, id)),
        ),
    );
    expect(file?.raw).toBeNull();
  });
});
