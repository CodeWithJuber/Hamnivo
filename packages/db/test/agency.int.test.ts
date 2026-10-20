import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;
let agency: SeededTenant;
let client: SeededTenant;
let other: SeededTenant;

const context = (tenant: SeededTenant) => ({
  tenantId: tenant.tenantId,
  actorId: tenant.staffMemberId,
});

beforeAll(async () => {
  h = await openHarness();
  agency = await seedTenant(h.app, 'agency');
  client = await seedTenant(h.app, 'client');
  other = await seedTenant(h.app, 'other');
  await withTenant(h.app, context(agency), (tx) =>
    tx.update(schema.agencyConfigs).set({ enabled: true }),
  );
});

afterAll(async () => {
  await h?.close();
});

describe('agency directory isolation', () => {
  it('shows linked client metadata only inside the parent and never grants child data access', async () => {
    await withTenant(h.app, context(agency), (tx) =>
      tx.insert(schema.agencyClients).values({
        tenantId: agency.tenantId,
        clientTenantId: client.tenantId,
        createdBy: agency.staffMemberId,
      }),
    );

    const parent = await withTenant(h.app, context(agency), async (tx) => {
      const metadata = await tx.execute<{ client_tenant_id: string; name: string }>(
        sql`select * from app.agency_client_metadata()`,
      );
      const childRows = await tx.select().from(schema.brands);
      return { metadata: metadata.rows, childRows };
    });
    expect(parent.metadata).toEqual([
      expect.objectContaining({ client_tenant_id: client.tenantId }),
    ]);
    expect(parent.childRows.some((b) => b.tenantId === client.tenantId)).toBe(false);

    const elsewhere = await withTenant(h.app, context(other), async (tx) => {
      const links = await tx.select().from(schema.agencyClients);
      const metadata = await tx.execute(sql`select * from app.agency_client_metadata()`);
      return { links, metadata: metadata.rows };
    });
    expect(elsewhere).toEqual({ links: [], metadata: [] });
  });

  it('prevents a second parent, nested agencies, and self-links', async () => {
    await withTenant(h.app, context(other), (tx) =>
      tx.update(schema.agencyConfigs).set({ enabled: true }),
    );
    await expectPgError(
      withTenant(h.app, context(other), (tx) =>
        tx.insert(schema.agencyClients).values({
          tenantId: other.tenantId,
          clientTenantId: client.tenantId,
          createdBy: other.staffMemberId,
        }),
      ),
      '23505',
    );
    await expectPgError(
      withTenant(h.app, context(client), (tx) =>
        tx.update(schema.agencyConfigs).set({ enabled: true }),
      ),
      '23514',
    );
    await expectPgError(
      withTenant(h.app, context(agency), (tx) =>
        tx.insert(schema.agencyClients).values({
          tenantId: agency.tenantId,
          clientTenantId: agency.tenantId,
          createdBy: agency.staffMemberId,
        }),
      ),
      '23514',
    );
    await expectPgError(
      withTenant(h.app, context(agency), (tx) =>
        tx.insert(schema.agencyClients).values({
          tenantId: agency.tenantId,
          clientTenantId: other.tenantId,
          createdBy: agency.staffMemberId,
        }),
      ),
      '23514',
    );
  });

  it('uses explicit immutable payer funding; an ordinary linked client pays for itself', async () => {
    const before = await withTenant(
      h.app,
      context(client),
      async (tx) =>
        (await tx.execute<{ payer: string }>(sql`select app.ai_payer_tenant() as payer`)).rows[0]
          ?.payer,
    );
    expect(before).toBe(client.tenantId);
    await withTenant(h.app, context(agency), (tx) =>
      tx.execute(sql`select app.fund_agency_client(${client.tenantId})`),
    );
    const after = await withTenant(
      h.app,
      context(client),
      async (tx) =>
        (await tx.execute<{ payer: string }>(sql`select app.ai_payer_tenant() as payer`)).rows[0]
          ?.payer,
    );
    expect(after).toBe(agency.tenantId);
    await expectPgError(
      withTenant(h.app, context(client), (tx) =>
        tx
          .insert(schema.agencyClientFunding)
          .values({ tenantId: other.tenantId, payerTenantId: agency.tenantId }),
      ),
      '42501',
    );
  });

  it('unlink leaves the child tenant, its members and data intact', async () => {
    await withTenant(h.app, context(agency), (tx) =>
      tx
        .delete(schema.agencyClients)
        .where(sql`${schema.agencyClients.clientTenantId} = ${client.tenantId}`),
    );
    const childState = await withTenant(h.app, context(client), async (tx) => ({
      members: await tx.select().from(schema.staffMembers),
      brands: await tx.select().from(schema.brands),
    }));
    expect(childState.members.some((m) => m.id === client.staffMemberId)).toBe(true);
    expect(childState.brands.some((b) => b.id === client.brandId)).toBe(true);
    const payer = await withTenant(
      h.app,
      context(client),
      async (tx) =>
        (await tx.execute<{ payer: string }>(sql`select app.ai_payer_tenant() as payer`)).rows[0]
          ?.payer,
    );
    expect(payer).toBe(agency.tenantId);
  });
});
