import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expiredActions, newId, schema, withTenant } from '../src/index.js';
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

const inTenant =
  (tenant: SeededTenant) =>
  <T>(work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(h.app, { tenantId: tenant.tenantId }, work);

async function tool(tenant: SeededTenant, name: string) {
  const [row] = await inTenant(tenant)((tx) =>
    tx.select().from(schema.toolDefinitions).where(eq(schema.toolDefinitions.name, name)),
  );
  if (!row) throw new Error(`${name} is not seeded`);
  return row;
}

async function approvedAction(tenant: SeededTenant) {
  const [row] = await inTenant(tenant)((tx) =>
    tx.select().from(schema.actions).where(eq(schema.actions.basis, 'approval')),
  );
  if (!row) throw new Error('no approved action seeded');
  return row;
}

/** A new action awaiting approval for tenant A's seeded tool. */
async function pendingAction(tenant: SeededTenant, expiresAt: Date) {
  const readTool = await tool(tenant, 'order_status');
  const id = newId();
  await inTenant(tenant)((tx) =>
    tx.insert(schema.actions).values({
      id,
      tenantId: tenant.tenantId,
      conversationId: tenant.conversationId,
      toolId: readTool.id,
      toolRevision: readTool.revision,
      toolName: readTool.name,
      toolTitle: readTool.title,
      risk: 'read',
      approver: 'customer',
      state: 'awaiting_approval',
      basis: 'approval',
      arguments: { orderReference: 'HV-1' },
      argumentsHash: randomBytes(32),
      summary: 'Read the status of order HV-1',
      ownerEpoch: 0,
      principalId: tenant.principalId,
      expiresAt,
    }),
  );
  return id;
}

describe('actions', () => {
  it('keep what was proposed: arguments, hash, binding and approver never change', async () => {
    const action = await approvedAction(a);
    const byId = eq(schema.actions.id, action.id);
    for (const change of [
      { arguments: { orderReference: 'HV-EVIL' } },
      { argumentsHash: randomBytes(32) },
      { toolRevision: 99 },
      { ownerEpoch: 7 },
      { resourceRevision: 'r-other' },
      { approver: 'staff' as const },
      { principalId: b.principalId },
      { expiresAt: new Date(Date.now() + 86_400_000 * 30) },
      { summary: 'Something else' },
      { basis: 'autopilot' as const },
    ]) {
      await expectPgError(
        inTenant(a)((tx) => tx.update(schema.actions).set(change).where(byId)),
        '23514',
      );
    }
    // Its state and completion move.
    await inTenant(a)((tx) =>
      tx.update(schema.actions).set({ state: 'completed', reason: null }).where(byId),
    );
    await expectPgError(
      inTenant(a)((tx) => tx.delete(schema.actions).where(byId)),
      '42501',
    );
  });

  it('refuse a money or irreversible action approved by a customer or run on autopilot', async () => {
    const readTool = await tool(a, 'order_status');
    const base = {
      tenantId: a.tenantId,
      conversationId: a.conversationId,
      toolId: readTool.id,
      toolRevision: 1,
      toolName: 'issue_credit',
      toolTitle: 'Issue credit',
      state: 'awaiting_approval' as const,
      arguments: {},
      argumentsHash: randomBytes(32),
      summary: 'Credit',
      ownerEpoch: 0,
    };
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .insert(schema.actions)
          .values({ ...base, risk: 'money', approver: 'customer', basis: 'approval' }),
      ),
      '23514',
    );
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .insert(schema.actions)
          .values({ ...base, risk: 'irreversible', approver: 'staff', basis: 'autopilot' }),
      ),
      '23514',
    );
    await expectPgError(
      inTenant(a)((tx) =>
        tx.insert(schema.actions).values({
          ...base,
          risk: 'write',
          approver: 'customer',
          basis: 'approval',
          argumentsHash: randomBytes(16),
        }),
      ),
      '23514',
    );
  });
});

describe('decided approvals and handoff packets', () => {
  it('are append-only', async () => {
    const [approval] = await inTenant(a)((tx) => tx.select().from(schema.actionApprovals));
    if (!approval) throw new Error('no approval seeded');
    const byId = eq(schema.actionApprovals.id, approval.id);
    await expectPgError(
      inTenant(a)((tx) =>
        tx.update(schema.actionApprovals).set({ decision: 'declined' }).where(byId),
      ),
      '42501',
    );
    await expectPgError(
      inTenant(a)((tx) => tx.delete(schema.actionApprovals).where(byId)),
      '42501',
    );
    await expectPgError(
      inTenant(a)((tx) => tx.update(schema.handoffPackets).set({ reason: 'edited' })),
      '42501',
    );
  });

  it('record one decision per action', async () => {
    const action = await approvedAction(a);
    await expectPgError(
      inTenant(a)((tx) =>
        tx.insert(schema.actionApprovals).values({
          tenantId: a.tenantId,
          actionId: action.id,
          decision: 'declined',
          approverKind: 'customer',
          approverId: 'cus_x',
          clientRequestId: newId(),
          argumentsHash: action.argumentsHash,
          toolRevision: action.toolRevision,
          ownerEpoch: action.ownerEpoch,
          stepUp: false,
          channel: 'widget',
          decidedAt: new Date(),
        }),
      ),
      '23505',
    );
  });
});

describe('tool definitions', () => {
  it('raise the revision on every policy change and keep their source, brand and name', async () => {
    const row = await tool(a, 'order_status');
    const byId = eq(schema.toolDefinitions.id, row.id);
    await expectPgError(
      inTenant(a)((tx) => tx.update(schema.toolDefinitions).set({ autopilot: false }).where(byId)),
      '23514',
    );
    await expectPgError(
      inTenant(a)((tx) =>
        tx.update(schema.toolDefinitions).set({ status: 'disabled' }).where(byId),
      ),
      '23514',
    );
    await inTenant(a)((tx) =>
      tx
        .update(schema.toolDefinitions)
        .set({ autopilot: false, revision: row.revision + 1 })
        .where(byId),
    );
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .update(schema.toolDefinitions)
          .set({ name: 'renamed', revision: row.revision + 2 })
          .where(byId),
      ),
      '23514',
    );
    await expectPgError(
      inTenant(a)((tx) => tx.delete(schema.toolDefinitions).where(byId)),
      '42501',
    );
  });

  it('keep money tools with staff approval and off autopilot', async () => {
    const row = await tool(a, 'order_status');
    await expectPgError(
      inTenant(a)((tx) =>
        tx
          .update(schema.toolDefinitions)
          .set({ risk: 'money', approver: 'customer', autopilot: false, revision: 50 })
          .where(eq(schema.toolDefinitions.id, row.id)),
      ),
      '23514',
    );
  });
});

describe('tool kill switches', () => {
  it('name the tool they stop', async () => {
    await expectPgError(
      inTenant(a)((tx) =>
        tx.insert(schema.killSwitches).values({
          tenantId: a.tenantId,
          scope: 'tool',
          reason: 'No tool named',
        }),
      ),
      '23514',
    );
  });
});

describe('expired approvals', () => {
  it('are found across tenants by id only, and only when overdue and undecided', async () => {
    const overdue = await pendingAction(a, new Date(Date.now() - 60_000));
    const future = await pendingAction(b, new Date(Date.now() + 3_600_000));
    const found = await expiredActions(h.app, 100);
    expect(found).toContainEqual({ tenantId: a.tenantId, id: overdue });
    expect(found.map((f) => f.id)).not.toContain(future);
    // The application role still cannot read another tenant's actions directly.
    const { rows } = await h.app.execute<{ n: string }>(
      sql`select count(*) as n from actions where id = ${overdue}::uuid`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
    await inTenant(a)((tx) =>
      tx
        .update(schema.actions)
        .set({ state: 'expired' })
        .where(and(eq(schema.actions.id, overdue), eq(schema.actions.state, 'awaiting_approval'))),
    );
    expect((await expiredActions(h.app, 100)).map((f) => f.id)).not.toContain(overdue);
  });

  it('are judged by the clock the worker passes', async () => {
    const later = await pendingAction(a, new Date(Date.now() + 3_600_000));
    expect((await expiredActions(h.app, 100)).map((f) => f.id)).not.toContain(later);
    const found = await expiredActions(h.app, 100, new Date(Date.now() + 7_200_000));
    expect(found.map((f) => f.id)).toContain(later);
  });
});
