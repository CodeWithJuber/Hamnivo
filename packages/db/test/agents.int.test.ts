import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let a: SeededTenant;

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
});

afterAll(async () => {
  await h?.close();
});

const inA = <T>(work: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(h.app, { tenantId: a.tenantId }, work);

const config = { displayName: 'Assistant', model: { provider: 'mock', modelId: 'hamnivo-mock' } };

describe('agent versions', () => {
  it('never changes or deletes a published version', async () => {
    const published = eq(schema.agentVersions.id, a.agentVersionId);
    await expectPgError(
      inA((tx) =>
        tx
          .update(schema.agentVersions)
          .set({ config: { ...config, displayName: 'Changed' } })
          .where(published),
      ),
      '23514',
    );
    await expectPgError(
      inA((tx) => tx.update(schema.agentVersions).set({ state: 'draft' }).where(published)),
      '23514',
    );
    await expectPgError(
      inA((tx) => tx.delete(schema.agentVersions).where(published)),
      '23514',
    );
    // Retiring is the one change a published version allows.
    await inA((tx) => tx.update(schema.agentVersions).set({ state: 'retired' }).where(published));
    const [row] = await inA((tx) => tx.select().from(schema.agentVersions).where(published));
    expect(row?.state).toBe('retired');
    expect(row?.config).toEqual(config);
  });

  it('lets a draft change, and keeps one draft per agent', async () => {
    const draft = and(
      eq(schema.agentVersions.profileId, a.agentId),
      eq(schema.agentVersions.state, 'draft'),
    );
    await inA((tx) =>
      tx
        .update(schema.agentVersions)
        .set({ config: { ...config, displayName: 'Edited draft' } })
        .where(draft),
    );
    await expectPgError(
      inA((tx) =>
        tx
          .insert(schema.agentVersions)
          .values({ tenantId: a.tenantId, profileId: a.agentId, version: 3, config }),
      ),
      '23505',
    );
  });

  it('refuses a published version without its hash and time', async () => {
    await expectPgError(
      inA((tx) =>
        tx.insert(schema.agentVersions).values({
          tenantId: a.tenantId,
          profileId: a.agentId,
          version: 9,
          state: 'retired',
          config,
        }),
      ),
      '23514',
    );
    await inA((tx) =>
      tx.insert(schema.agentVersions).values({
        tenantId: a.tenantId,
        profileId: a.agentId,
        version: 9,
        state: 'retired',
        config,
        configHash: randomBytes(32),
        publishedAt: new Date(),
      }),
    );
  });

  it('keeps one live version per agent', async () => {
    const published = {
      tenantId: a.tenantId,
      profileId: a.agentId,
      state: 'published' as const,
      config,
      configHash: randomBytes(32),
      publishedAt: new Date(),
    };
    await inA((tx) => tx.insert(schema.agentVersions).values({ ...published, version: 10 }));
    await expectPgError(
      inA((tx) => tx.insert(schema.agentVersions).values({ ...published, version: 11 })),
      '23505',
    );
  });
});

describe('agent profiles', () => {
  it('allows one active default agent per brand', async () => {
    await expectPgError(
      inA((tx) =>
        tx.insert(schema.agentProfiles).values({
          tenantId: a.tenantId,
          workspaceId: a.workspaceId,
          brandId: a.brandId,
          name: 'Second default',
          isDefault: true,
        }),
      ),
      '23505',
    );
    await inA((tx) =>
      tx.insert(schema.agentProfiles).values({
        tenantId: a.tenantId,
        workspaceId: a.workspaceId,
        brandId: a.brandId,
        name: 'Archived default',
        isDefault: true,
        status: 'archived',
      }),
    );
  });
});

describe('kill switches', () => {
  it('are cleared, never deleted', async () => {
    const [created] = await inA((tx) =>
      tx
        .insert(schema.killSwitches)
        .values({ tenantId: a.tenantId, scope: 'tenant', reason: 'Incident drill' })
        .returning(),
    );
    const byId = eq(schema.killSwitches.id, created?.id ?? '');
    await expectPgError(
      inA((tx) => tx.delete(schema.killSwitches).where(byId)),
      '42501',
    );
    await inA((tx) => tx.update(schema.killSwitches).set({ clearedAt: new Date() }).where(byId));
  });

  it('require a target that matches the scope', async () => {
    await expectPgError(
      inA((tx) =>
        tx
          .insert(schema.killSwitches)
          .values({ tenantId: a.tenantId, scope: 'brand', reason: 'No brand given' }),
      ),
      '23514',
    );
  });
});
