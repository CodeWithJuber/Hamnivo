import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyMemoryTombstones,
  expiredMemorySubjects,
  newId,
  schema,
  type TenantTx,
  withTenant,
} from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;

const hourAgo = () => new Date(Date.now() - 3_600_000);

/** A memory record for the seeded customer; overrides replace any field. */
function record(
  tenant: SeededTenant,
  overrides: Partial<typeof schema.memoryRecords.$inferInsert> = {},
): typeof schema.memoryRecords.$inferInsert {
  const observedAt = hourAgo();
  return {
    tenantId: tenant.tenantId,
    workspaceId: tenant.workspaceId,
    brandId: tenant.brandId,
    subjectId: tenant.principalId,
    scope: 'person',
    kind: 'preference',
    key: 'delivery_note',
    payload: { value: 'Call at reception' },
    contentHash: randomBytes(32),
    sourceType: 'customer_statement',
    evidenceStatus: 'supported',
    writtenByType: 'ai',
    writeReason: 'extracted_from_message',
    purpose: 'Ensure smooth delivery',
    allowedPurposes: ['ai_replies', 'staff_context'],
    allowedRoles: ['customer', 'staff', 'ai'],
    sensitivity: 'personal',
    retentionClass: 'medium',
    expiresAt: new Date(Date.now() + 86_400_000),
    policyVersion: 'memory-write/1',
    status: 'active',
    reviewStatus: 'auto',
    observedAt,
    validFrom: observedAt,
    ...overrides,
  };
}

const inA = <T>(work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: a.tenantId }, work);

async function tombstone(
  tx: TenantTx,
  tenant: SeededTenant,
  target: { type: 'memory_record' | 'memory_subject'; id: string; observedAt: Date },
) {
  const [deletion] = await tx
    .insert(schema.memoryDeletions)
    .values({
      tenantId: tenant.tenantId,
      brandId: tenant.brandId,
      subjectId: tenant.principalId,
      scope: target.type === 'memory_record' ? 'record' : 'customer',
      reason: 'customer_request',
      requestedByType: 'customer',
      recordCount: 1,
      steps: { records: 'done' },
    })
    .returning();
  await tx.insert(schema.deletionTombstones).values({
    tenantId: tenant.tenantId,
    deletionId: deletion?.id ?? '',
    subjectId: tenant.principalId,
    targetType: target.type,
    targetId: target.id,
    observedAt: target.observedAt,
  });
}

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
});

afterAll(async () => {
  await h?.close();
});

describe('memory records', () => {
  it('never overwrite content: only the lifecycle of a record changes', async () => {
    const [row] = await inA((tx) => tx.insert(schema.memoryRecords).values(record(a)).returning());
    const id = row?.id ?? '';
    for (const change of [
      sql`payload = '{"value":"Leave at the door"}'::jsonb`,
      sql`key = 'contact_method'`,
      sql`subject_id = ${b.principalId}::uuid`,
      sql`valid_from = now() - interval '9 days'`,
      sql`source_event_ids = '{msg_other}'::text[]`,
    ]) {
      await expectPgError(
        inA((tx) => tx.execute(sql`update memory_records set ${change} where id = ${id}::uuid`)),
        '23514',
      );
    }
    // Superseding closes validity and links the next version; that is allowed.
    await inA((tx) =>
      tx
        .update(schema.memoryRecords)
        .set({ status: 'superseded', validUntil: new Date(), supersededAt: new Date() })
        .where(eq(schema.memoryRecords.id, id)),
    );
    // History cannot become current again.
    await expectPgError(
      inA((tx) =>
        tx.update(schema.memoryRecords).set({ status: 'active' }).where(eq(schema.memoryRecords.id, id)),
      ),
      '23514',
    );
  });

  it('never has two current values for one slot', async () => {
    await inA((tx) => tx.insert(schema.memoryRecords).values(record(a, { key: 'contact_method' })));
    await expectPgError(
      inA((tx) => tx.insert(schema.memoryRecords).values(record(a, { key: 'contact_method' }))),
      '23505',
    );
    // A disagreeing value may wait for review next to it, but only one.
    await inA((tx) =>
      tx
        .insert(schema.memoryRecords)
        .values(record(a, { key: 'contact_method', status: 'pending', reviewStatus: 'pending' })),
    );
    await expectPgError(
      inA((tx) =>
        tx
          .insert(schema.memoryRecords)
          .values(record(a, { key: 'contact_method', status: 'pending', reviewStatus: 'pending' })),
      ),
      '23505',
    );
  });

  it('delete their vectors with them', async () => {
    const id = newId();
    await inA(async (tx) => {
      await tx.insert(schema.memoryRecords).values(record(a, { id, key: 'size_preference' }));
      await tx.insert(schema.memoryEmbeddings).values({
        tenantId: a.tenantId,
        memoryId: id,
        subjectId: a.principalId,
        embedding: Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0)),
        embeddingModel: 'hamnivo:test',
        contentHash: randomBytes(32),
      });
      await tx.delete(schema.memoryRecords).where(eq(schema.memoryRecords.id, id));
    });
    const left = await inA((tx) =>
      tx.select().from(schema.memoryEmbeddings).where(eq(schema.memoryEmbeddings.memoryId, id)),
    );
    expect(left).toEqual([]);
  });
});

describe('deletion tombstones', () => {
  it('refuse to write a deleted record again', async () => {
    const id = newId();
    await inA((tx) => tombstone(tx, a, { type: 'memory_record', id, observedAt: hourAgo() }));
    await expectPgError(
      inA((tx) => tx.insert(schema.memoryRecords).values(record(a, { id, key: 'product_interest' }))),
      '23514',
    );
  });

  it('refuse anything observed before an erasure, and allow what comes after', async () => {
    const principal = await withTenant(h.app, { tenantId: b.tenantId }, async (tx) => {
      const [row] = await tx
        .insert(schema.customerPrincipals)
        .values({
          tenantId: b.tenantId,
          brandId: b.brandId,
          kind: 'verified',
          externalSubject: `erased-${randomBytes(3).toString('hex')}`,
        })
        .returning();
      return row?.id ?? '';
    });
    const subject = { ...b, principalId: principal };
    const erasedAt = new Date();
    await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tombstone(tx, subject, { type: 'memory_subject', id: principal, observedAt: erasedAt }),
    );
    await expectPgError(
      withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
        tx.insert(schema.memoryRecords).values(record(subject)),
      ),
      '23514',
    );
    const later = new Date(erasedAt.getTime() + 1000);
    await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      tx.insert(schema.memoryRecords).values(record(subject, { observedAt: later, validFrom: later })),
    );
  });

  it('are append-only, and deletion receipts are never deleted', async () => {
    await expectPgError(inA((tx) => tx.execute(sql`delete from deletion_tombstones`)), '42501');
    await expectPgError(
      inA((tx) => tx.execute(sql`update deletion_tombstones set memory_key = null`)),
      '42501',
    );
    await expectPgError(inA((tx) => tx.execute(sql`delete from learning_consents`)), '42501');
    await expectPgError(
      inA((tx) => tx.execute(sql`update learning_consents set state = 'granted'`)),
      '42501',
    );
    await expectPgError(inA((tx) => tx.execute(sql`delete from memory_deletions`)), '42501');
  });

  it('are replayed after a restore brings deleted memory back', async () => {
    const id = newId();
    await inA(async (tx) => {
      await tx.insert(schema.memoryRecords).values(record(a, { id, key: 'open_issue' }));
      await tx.insert(schema.memoryEmbeddings).values({
        tenantId: a.tenantId,
        memoryId: id,
        subjectId: a.principalId,
        embedding: Array.from({ length: 768 }, (_, i) => (i === 2 ? 1 : 0)),
        embeddingModel: 'hamnivo:test',
        contentHash: randomBytes(32),
      });
      await tombstone(tx, a, { type: 'memory_record', id, observedAt: hourAgo() });
    });
    // The record is still there, as if restored from a backup taken before the deletion.
    const before = await inA((tx) =>
      tx.select().from(schema.memoryRecords).where(eq(schema.memoryRecords.id, id)),
    );
    expect(before).toHaveLength(1);
    expect(await applyMemoryTombstones(h.app)).toBeGreaterThanOrEqual(1);
    const after = await inA(async (tx) => ({
      records: await tx.select().from(schema.memoryRecords).where(eq(schema.memoryRecords.id, id)),
      vectors: await tx
        .select()
        .from(schema.memoryEmbeddings)
        .where(eq(schema.memoryEmbeddings.memoryId, id)),
    }));
    expect(after).toEqual({ records: [], vectors: [] });
    expect(await applyMemoryTombstones(h.app)).toBe(0);
  });
});

describe('retention', () => {
  it('finds customers with expired memory in every tenant', async () => {
    const past = new Date(Date.now() - 1000);
    await inA((tx) =>
      tx
        .insert(schema.memoryRecords)
        .values(record(a, { key: 'stated_order_reference', expiresAt: past })),
    );
    const expired = await expiredMemorySubjects(h.app);
    expect(expired).toContainEqual({
      tenantId: a.tenantId,
      subjectId: a.principalId,
      brandId: a.brandId,
    });
    expect(expired.some((e) => e.tenantId === b.tenantId)).toBe(false);
  });
});
