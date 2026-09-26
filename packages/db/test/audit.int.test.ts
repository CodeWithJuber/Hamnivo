import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAudit,
  ensureAuditPartitions,
  schema,
  verifyAuditChain,
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

const staffEvent = (action: string) => ({
  actorType: 'staff' as const,
  actorId: 'stf_1',
  action,
  targetType: 'grant',
  targetId: 'grt_1',
  outcome: 'success' as const,
  data: { role: 'supervisor', scope: { type: 'team', id: 'team_1' } },
});

describe('audit log', () => {
  it('chains events per tenant and verifies', async () => {
    const appended = await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => [
      await appendAudit(tx, staffEvent('grant.created')),
      await appendAudit(tx, staffEvent('grant.revoked')),
    ]);
    // seedTenant already wrote seq 1 (tenant.created).
    expect(appended.map((e) => e.seq)).toEqual([2, 3]);
    const result = await withTenant(h.app, { tenantId: a.tenantId }, (tx) => verifyAuditChain(tx));
    expect(result).toEqual({ ok: true, checked: 3, lastSeq: 3 });

    const other = await withTenant(h.app, { tenantId: b.tenantId }, (tx) => verifyAuditChain(tx));
    expect(other).toEqual({ ok: true, checked: 1, lastSeq: 1 });
  });

  it('serializes concurrent appends into a gap-free chain', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
          appendAudit(tx, staffEvent(`bulk.${i}`)),
        ),
      ),
    );
    const result = await withTenant(h.app, { tenantId: b.tenantId }, (tx) => verifyAuditChain(tx));
    expect(result).toEqual({ ok: true, checked: 9, lastSeq: 9 });
  });

  it('rolls the audit event back with the transaction it belongs to', async () => {
    await expect(
      withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
        await appendAudit(tx, staffEvent('grant.created'));
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    const result = await withTenant(h.app, { tenantId: a.tenantId }, (tx) => verifyAuditChain(tx));
    expect(result).toEqual({ ok: true, checked: 3, lastSeq: 3 });
  });

  it('is append-only for the application role', async () => {
    await expectPgError(
      withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
        tx
          .update(schema.auditEvents)
          .set({ action: 'edited' })
          .where(eq(schema.auditEvents.seq, 2)),
      ),
      '42501',
    );
    await expectPgError(
      withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
        tx.delete(schema.auditEvents).where(eq(schema.auditEvents.seq, 2)),
      ),
      '42501',
    );
  });

  it('detects tampering by a privileged database user', async () => {
    // Simulate an operator editing history directly: the owner lifts FORCE RLS on this
    // throwaway database and rewrites one event.
    await h.owner.execute(sql`alter table audit_events no force row level security`);
    await h.owner.execute(
      sql`update audit_events set action = 'grant.rewritten' where tenant_id = ${a.tenantId}::uuid and seq = 2`,
    );
    await h.owner.execute(sql`alter table audit_events force row level security`);
    const result = await withTenant(h.app, { tenantId: a.tenantId }, (tx) => verifyAuditChain(tx));
    expect(result).toEqual({ ok: false, seq: 2, reason: 'hash_mismatch' });
  });

  it('routes events into monthly partitions and adopts early arrivals from the default', async () => {
    expect(await ensureAuditPartitions(h.app, 2)).toBe(0);
    const now = new Date();
    const later = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 4, 15));
    const event = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
      appendAudit(tx, { ...staffEvent('scheduled.export'), occurredAt: later }),
    );
    const partitionOf = async () => {
      const { rows } = await withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
        tx.execute<{ part: string }>(
          sql`select tableoid::regclass::text as part from audit_events where seq = ${event.seq}`,
        ),
      );
      return rows[0]?.part;
    };
    expect(await partitionOf()).toBe('audit_events_default');

    expect(await ensureAuditPartitions(h.app, 5)).toBe(3);
    const month = String(later.getUTCMonth() + 1).padStart(2, '0');
    expect(await partitionOf()).toBe(`audit_events_y${later.getUTCFullYear()}m${month}`);
    const result = await withTenant(h.app, { tenantId: b.tenantId }, (tx) => verifyAuditChain(tx));
    expect(result.ok).toBe(true);
  });
});
