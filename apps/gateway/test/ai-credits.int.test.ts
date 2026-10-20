import { randomUUID } from 'node:crypto';
import { closeDb, createDb, type Db, schema, toPublicId, withTenant } from '@hamnivo/db';
import {
  createTestDatabase,
  type SeededTenant,
  seedTenant,
  type TestDatabase,
} from '@hamnivo/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { type AiAttemptSpec, AiCreditsService } from '../src/billing/ai-credits.service.js';

import type { AppConfig } from '../src/config.js';
import type { EgressService } from '../src/developer/egress.service.js';
import { ModelFactory } from '../src/runtime/models.js';
import type { SecretBroker } from '../src/secrets/secret-broker.service.js';

let database: TestDatabase;
let db: Db;
let service: AiCreditsService;
let current = new Date('2026-10-20T12:00:00Z');
let agency: SeededTenant;
let child: SeededTenant;
let sibling: SeededTenant;
const context = (t: SeededTenant) => ({ tenantId: t.tenantId, actorId: t.staffMemberId });
const attempt = (t: SeededTenant, extra: Partial<AiAttemptSpec> = {}): AiAttemptSpec => ({
  tenantId: t.tenantId,
  key: randomUUID(),
  provider: 'mock',
  modelId: 'test',
  source: 'managed',
  reserveTokens: 70,
  timeoutMs: 1,
  ...extra,
});
async function budget(t: SeededTenant, value: number | null) {
  await withTenant(db, context(t), (tx) =>
    tx
      .insert(schema.tenantEntitlements)
      .values({ tenantId: t.tenantId, aiTokenBudget: value })
      .onConflictDoUpdate({
        target: schema.tenantEntitlements.tenantId,
        set: { aiTokenBudget: value },
      }),
  );
}
beforeAll(async () => {
  database = await createTestDatabase(inject('templateDatabase'));
  db = createDb(database.app, { max: 6 });
  service = new AiCreditsService(db, () => current);
  agency = await seedTenant(db, 'credits-agency');
  child = await seedTenant(db, 'credits-child');
  sibling = await seedTenant(db, 'credits-sibling');
  // The exhaustive fixture includes a demonstration hold; this suite owns its ledger.
  for (const tenant of [agency, child, sibling]) {
    await withTenant(db, context(tenant), (tx) => tx.delete(schema.aiCreditAttempts));
  }
  await withTenant(db, context(agency), async (tx) => {
    await tx
      .insert(schema.agencyConfigs)
      .values({ tenantId: agency.tenantId, enabled: true })
      .onConflictDoUpdate({ target: schema.agencyConfigs.tenantId, set: { enabled: true } });
    for (const client of [child, sibling]) {
      await tx.insert(schema.agencyClients).values({
        tenantId: agency.tenantId,
        clientTenantId: client.tenantId,
        createdBy: agency.staffMemberId,
      });
      await tx.execute(sql`select app.fund_agency_client(${client.tenantId}::uuid)`);
    }
  });
});
afterAll(async () => {
  if (db) await closeDb(db);
  await database?.drop();
});

describe('atomic AI reservations with explicit agency funding', () => {
  it('serializes concurrent requests across funded clients without exposing sibling ledgers', async () => {
    await budget(agency, 100);
    const results = await Promise.allSettled([
      service.reserve(attempt(child)),
      service.reserve(attempt(sibling)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winner = results.find((r) => r.status === 'fulfilled');
    if (winner?.status !== 'fulfilled') throw new Error('Missing winner');
    await service.settle(winner.value, { inputTokens: 12, outputTokens: 8 });
    await service.settle(winner.value, { inputTokens: 12, outputTokens: 8 });
    const ledger = await withTenant(
      db,
      { tenantId: winner.value.tenantId, actorId: 'test' },
      async (tx) =>
        (
          await tx.execute<{ count: number; quantity: string }>(
            sql`select count(*)::int as count, sum(quantity)::text as quantity from usage_entries where dedupe_key like 'ai:%'`,
          )
        ).rows[0],
    );
    expect(ledger).toEqual({ count: 2, quantity: '20' });
    await expect(service.reserve(attempt(agency, { reserveTokens: 90 }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    const childView = await service.overview(child.tenantId);
    expect(childView.payerTenantId).toBe(agency.tenantId);
    const parentView = await service.overview(agency.tenantId);
    expect(parentView.attempts).toHaveLength(0);
    const other = winner.value.tenantId === child.tenantId ? sibling : child;
    expect((await service.overview(other.tenantId)).attempts).toHaveLength(0);
  });
  it('uses receipts to free unused reserve and blocks duplicate provider-attempt keys', async () => {
    const spec = attempt(child, { reserveTokens: 70 });
    const reservation = await service.reserve(spec);
    await expect(service.reserve(spec)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await service.settle(reservation, { inputTokens: 3, outputTokens: 2 });
    const next = await service.reserve(attempt(sibling, { reserveTokens: 70 }));
    await service.release(next);
    await service.release(next);
  });
  it('holds expired uncertain calls and accepts late receipts in the original period', async () => {
    const reservation = await service.reserve(attempt(child, { reserveTokens: 70 }));
    current = new Date('2026-10-20T13:00:00Z');
    await expect(service.reserve(attempt(sibling, { reserveTokens: 10 }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    // This other workspace can neither settle nor release the reservation.
    await expect(
      service.settle(
        { ...reservation, tenantId: sibling.tenantId },
        { inputTokens: 1, outputTokens: 1 },
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    current = new Date('2026-11-01T00:01:00Z');
    await service.settle(reservation, { inputTokens: 6, outputTokens: 4 });
    const usage = await withTenant(db, context(child), (tx) =>
      tx.execute<{ at: Date }>(sql`
      select occurred_at as at from usage_entries where dedupe_key like 'ai:%' order by occurred_at desc limit 1`),
    );
    expect(new Date(usage.rows[0]?.at ?? '').toISOString().startsWith('2026-10')).toBe(true);
  });
  it('records BYOK usage without consuming managed tokens even at zero managed allowance', async () => {
    await budget(agency, 0);
    const reservation = await service.reserve(attempt(child, { source: 'byok' }));
    await service.settle(reservation, { inputTokens: 20, outputTokens: 30 });
    const overview = await service.overview(child.tenantId);
    expect(overview.byok.tokens).toBe(50);
    expect(overview.managed.settledTokens).toBe(0);
    expect(overview.attempts[0]).toMatchObject({
      source: 'byok',
      creditsMilli: 0,
      reservedTokens: 0,
    });
  });
  it('keeps partial receipts conservative and reconciles them without double token writes', async () => {
    await budget(agency, 100);
    const reservation = await service.reserve(attempt(sibling, { reserveTokens: 70 }));
    await service.settle(reservation, { inputTokens: 5, outputTokens: null });
    await expect(service.reserve(attempt(child, { reserveTokens: 30 }))).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    await service.settle(reservation, { inputTokens: 5, outputTokens: 3 });
    await service.settle(reservation, { inputTokens: 5, outputTokens: 3 });
    const overview = await service.overview(sibling.tenantId);
    expect(overview.managed).toEqual({ settledTokens: 8, reservedTokens: 0, creditsMilli: 8000 });
    const next = await service.reserve(attempt(child, { reserveTokens: 90 }));
    await service.release(next);
  });
  it('never uses platform credentials for an inaccessible explicit BYOK connection', async () => {
    const [foreignConnection] = await withTenant(db, context(sibling), (tx) =>
      tx.select().from(schema.modelConnections),
    );
    if (!foreignConnection) throw new Error('Fixture missing model connection');
    const reveal = vi.fn(async () => 'tenant-key');
    const factory = new ModelFactory(
      db,
      { OPENAI_API_KEY: 'platform-key' } as AppConfig,
      { reveal } as unknown as SecretBroker,
      { policyIn: async () => ({ allowedHosts: [] }) } as unknown as EgressService,
      service,
    );
    await expect(
      factory.resolve(child.tenantId, {
        provider: foreignConnection.provider,
        modelId: 'test',
        connectionId: toPublicId('modelConnection', foreignConnection.id),
      }),
    ).rejects.toMatchObject({ reason: 'connection_disabled' });
    expect(reveal).not.toHaveBeenCalled();
    const managed = await factory.resolve(child.tenantId, { provider: 'openai', modelId: 'test' });
    expect(managed.source).toBe('managed');
    const [ownConnection] = await withTenant(db, context(child), (tx) =>
      tx.select().from(schema.modelConnections),
    );
    if (!ownConnection) throw new Error('Fixture missing model connection');
    const byok = await factory.resolve(child.tenantId, {
      provider: ownConnection.provider,
      modelId: 'test',
      connectionId: toPublicId('modelConnection', ownConnection.id),
    });
    expect(byok.source).toBe('byok');
    expect(reveal).toHaveBeenCalledOnce();
  });
});
