import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, type TenantTx, withTenant } from '../src/index.js';
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

const inA = <T>(work: (tx: TenantTx) => Promise<T>) =>
  withTenant(h.app, { tenantId: a.tenantId }, work);

async function versionOf(tenant: SeededTenant, dependency: string): Promise<number> {
  return withTenant(h.app, { tenantId: tenant.tenantId }, async (tx) => {
    const [row] = await tx
      .select({ version: schema.cacheDependencyVersions.version })
      .from(schema.cacheDependencyVersions)
      .where(eq(schema.cacheDependencyVersions.dependency, dependency));
    return row?.version ?? 0;
  });
}

describe('decision rubrics (J05)', () => {
  const published = () => eq(schema.decisionRubrics.id, a.rubricId);

  it('never changes or deletes a published rubric', async () => {
    await expectPgError(
      inA((tx) =>
        tx
          .update(schema.decisionRubrics)
          .set({ definition: { intents: [] } })
          .where(published()),
      ),
      '23514',
    );
    await expectPgError(
      inA((tx) =>
        tx.update(schema.decisionRubrics).set({ modelVersion: 'jev-9.9.9' }).where(published()),
      ),
      '23514',
    );
    await expectPgError(
      inA((tx) => tx.delete(schema.decisionRubrics).where(published())),
      '23514',
    );
    // Retiring is the one change a published rubric allows.
    await inA((tx) =>
      tx.update(schema.decisionRubrics).set({ state: 'retired' }).where(published()),
    );
  });

  it('lets a draft change and keeps one draft per task', async () => {
    const draft = and(
      eq(schema.decisionRubrics.brandId, a.brandId),
      eq(schema.decisionRubrics.state, 'draft'),
    );
    await inA((tx) => tx.update(schema.decisionRubrics).set({ deadlineMs: 1200 }).where(draft));
    await expectPgError(
      inA((tx) =>
        tx.insert(schema.decisionRubrics).values({
          tenantId: a.tenantId,
          brandId: a.brandId,
          task: 'team-routing',
          version: 3,
          definition: {},
        }),
      ),
      '23505',
    );
  });

  it('refuses a deadline outside 100 ms to 10 s', async () => {
    await expectPgError(
      inA((tx) =>
        tx.insert(schema.decisionRubrics).values({
          tenantId: a.tenantId,
          brandId: a.brandId,
          task: 'other-task',
          version: 1,
          definition: {},
          deadlineMs: 60_000,
        }),
      ),
      '23514',
    );
  });
});

describe('decision records (J07)', () => {
  const record = () => eq(schema.decisionRecords.id, a.decisionId);

  it('keeps what was decided and lets only applying and reviewing change', async () => {
    await expectPgError(
      inA((tx) => tx.update(schema.decisionRecords).set({ finalIntent: 'orders' }).where(record())),
      '23514',
    );
    await expectPgError(
      inA((tx) => tx.update(schema.decisionRecords).set({ confidence: 0.99 }).where(record())),
      '23514',
    );
    await inA((tx) =>
      tx
        .update(schema.decisionRecords)
        .set({
          reviewedIntent: 'orders',
          reviewReason: 'The customer asked about delivery.',
          reviewedAt: new Date(),
          trainingConsent: true,
        })
        .where(record()),
    );
    const [row] = await inA((tx) => tx.select().from(schema.decisionRecords).where(record()));
    expect(row).toMatchObject({ finalIntent: 'billing', reviewedIntent: 'orders' });
  });

  it('cannot be deleted by the application', async () => {
    await expectPgError(
      inA((tx) => tx.delete(schema.decisionRecords).where(record())),
      '42501',
    );
  });

  it('never stores a confidence outside 0 to 1', async () => {
    await expectPgError(
      inA((tx) =>
        tx.insert(schema.decisionRecords).values({
          tenantId: a.tenantId,
          brandId: a.brandId,
          task: 'team-routing',
          trigger: 'test',
          triggerRef: 'test:1',
          mode: 'test',
          provider: 'jev',
          status: 'decided',
          confidence: 1.4,
          baselineIntent: 'other',
          finalIntent: 'other',
          finalSource: 'baseline',
          teamBasis: 'none',
          languageMatch: 'unknown',
        }),
      ),
      '23514',
    );
  });
});

describe('cache dependency versions (K07)', () => {
  it('rise when a knowledge document changes, in the same transaction', async () => {
    const dependency = `knowledge:source:${a.knowledgeSourceId}`;
    const before = await versionOf(a, dependency);
    await inA((tx) =>
      tx
        .update(schema.knowledgeDocuments)
        .set({ status: 'retired' })
        .where(eq(schema.knowledgeDocuments.id, a.documentId)),
    );
    expect(await versionOf(a, dependency)).toBe(before + 1);
    // A change that is rolled back leaves the version as it was.
    await inA(async (tx) => {
      await tx
        .update(schema.knowledgeDocuments)
        .set({ status: 'active' })
        .where(eq(schema.knowledgeDocuments.id, a.documentId));
      await tx.execute(sql`select 1/0`);
    }).catch(() => undefined);
    expect(await versionOf(a, dependency)).toBe(before + 1);
  });

  it('rise when a source changes visibility, an agent is published or a brand is renamed', async () => {
    const source = `knowledge:source:${a.knowledgeSourceId}`;
    const agent = `agent:${a.agentId}`;
    const brand = `brand:${a.brandId}`;
    const before = await Promise.all([source, agent, brand].map((d) => versionOf(a, d)));
    await inA(async (tx) => {
      await tx
        .update(schema.knowledgeSources)
        .set({ visibility: 'internal' })
        .where(eq(schema.knowledgeSources.id, a.knowledgeSourceId));
      await tx
        .update(schema.agentProfiles)
        .set({ publishedVersionId: null })
        .where(eq(schema.agentProfiles.id, a.agentId));
      await tx
        .update(schema.brands)
        .set({ name: 'Renamed brand' })
        .where(eq(schema.brands.id, a.brandId));
    });
    const after = await Promise.all([source, agent, brand].map((d) => versionOf(a, d)));
    expect(after).toEqual(before.map((v) => v + 1));
  });

  it('never touches another tenant', async () => {
    const dependency = `brand:${b.brandId}`;
    const before = await versionOf(b, dependency);
    await inA((tx) => tx.update(schema.brands).set({ name: 'Alpha again' }));
    expect(await versionOf(b, dependency)).toBe(before);
    // Tenant A cannot raise B's versions directly either.
    await expectPgError(
      inA((tx) =>
        tx.execute(sql`select app.bump_cache_dependency(${b.tenantId}::uuid, ${dependency})`),
      ),
      '42501',
    );
  });
});
