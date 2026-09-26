import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createDb,
  type Db,
  schema,
  TenantContextError,
  withTenant,
} from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let single: Db;
let a: SeededTenant;

beforeAll(async () => {
  h = await openHarness();
  single = createDb(h.database.app, { max: 1 });
  a = await seedTenant(h.app, 'alpha');
});

afterAll(async () => {
  await closeDb(single);
  await h?.close();
});

describe('withTenant', () => {
  it('rejects anything but a tenant UUID before touching the database', async () => {
    await expect(withTenant(h.app, { tenantId: "x' or true --" }, async () => 1)).rejects.toThrow(
      TenantContextError,
    );
  });

  it('keeps the tenant setting transaction-local on a reused pooled connection', async () => {
    await withTenant(single, { tenantId: a.tenantId }, async (tx) => {
      const rows = await tx.select().from(schema.tenants);
      expect(rows).toHaveLength(1);
    });
    const { rows } = await single.execute<{ tenant: string | null; n: string }>(
      sql`select app.current_tenant()::text as tenant, (select count(*) from tenants) as n`,
    );
    expect(rows[0]).toEqual({ tenant: null, n: '0' });
  });

  it('records the acting principal for the transaction', async () => {
    const actor = await withTenant(
      single,
      { tenantId: a.tenantId, actorId: 'stf_42' },
      async (tx) => {
        const { rows } = await tx.execute<{ actor: string }>(
          sql`select app.current_actor() as actor`,
        );
        return rows[0]?.actor;
      },
    );
    expect(actor).toBe('stf_42');
  });

  it('applies the statement timeout inside the transaction', async () => {
    await expectPgError(
      withTenant(single, { tenantId: a.tenantId, statementTimeoutMs: 50 }, (tx) =>
        tx.execute(sql`select pg_sleep(1)`),
      ),
      '57014',
    );
  });

  it('rolls back every write when the work fails', async () => {
    await expect(
      withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
        await tx.update(schema.tenants).set({ name: 'Renamed' });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const [tenant] = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(schema.tenants),
    );
    expect(tenant?.name).not.toBe('Renamed');
  });
});
