import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, purgeAiDrafts, schema, withTenant } from '../src/index.js';
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

async function draftIn(state: 'pending' | 'approved') {
  const [row] = await inA((tx) =>
    tx.select().from(schema.aiDrafts).where(eq(schema.aiDrafts.state, state)),
  );
  if (!row) throw new Error(`no ${state} draft seeded`);
  return row;
}

/** A new draft row for this tenant, rejected by a person at `endedAt`, with their decision. */
async function endedDraft(endedAt: Date) {
  const seeded = await draftIn('approved');
  const runId = newId();
  const id = newId();
  const decisionId = newId();
  await inA(async (tx) => {
    const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, seeded.runId));
    if (!run) throw new Error('the seeded draft has a run');
    await tx
      .insert(schema.runs)
      .values({ ...run, id: runId, triggerRef: `draft:${runId}`, attempts: 1 });
    await tx.insert(schema.aiDrafts).values({
      ...seeded,
      id,
      runId,
      state: 'rejected',
      decidedBy: a.staffMemberId,
      decidedAt: endedAt,
    });
    await tx.insert(schema.aiDraftDecisions).values({
      id: decisionId,
      tenantId: a.tenantId,
      draftId: id,
      staffMemberId: a.staffMemberId,
      clientRequestId: newId(),
      decision: 'rejected',
      ownerEpoch: seeded.ownerEpoch,
      reason: 'not_needed',
      createdAt: endedAt,
    });
  });
  return { id, decisionId };
}

describe('AI drafts (HNV-09-05)', () => {
  it('keep what they say, cite and answer', async () => {
    const pending = await draftIn('pending');
    for (const change of [
      sql`text = 'Something else'`,
      sql`sources = '[]'::jsonb`,
      sql`trigger_ledger_id = ${newId()}::uuid`,
      sql`owner_epoch = owner_epoch + 1`,
    ]) {
      await expectPgError(
        inA((tx) => tx.execute(sql`update ai_drafts set ${change} where id = ${pending.id}::uuid`)),
        '23514',
      );
    }
  });

  it('are decided once: a decided draft never changes again', async () => {
    const approved = await draftIn('approved');
    await expectPgError(
      inA((tx) =>
        tx.execute(sql`update ai_drafts set state = 'rejected' where id = ${approved.id}::uuid`),
      ),
      '23514',
    );
    // A pending one moves on, once.
    const pending = await draftIn('pending');
    await inA((tx) =>
      tx
        .update(schema.aiDrafts)
        .set({ state: 'superseded', supersededReason: 'replaced', decidedAt: new Date() })
        .where(eq(schema.aiDrafts.id, pending.id)),
    );
    await expectPgError(
      inA((tx) =>
        tx.execute(
          sql`update ai_drafts set superseded_reason = 'resolved' where id = ${pending.id}::uuid`,
        ),
      ),
      '23514',
    );
  });

  it('allow one pending draft per conversation, and say consistently how they ended', async () => {
    const seeded = await draftIn('approved');
    const runId = newId();
    await inA(async (tx) => {
      const [run] = await tx.select().from(schema.runs).where(eq(schema.runs.id, seeded.runId));
      if (!run) throw new Error('the seeded draft has a run');
      await tx.insert(schema.runs).values({ ...run, id: runId, triggerRef: `draft:${runId}` });
    });
    const fresh = {
      ...seeded,
      id: newId(),
      runId,
      state: 'pending' as const,
      decidedBy: null,
      decidedAt: null,
    };
    await inA((tx) => tx.insert(schema.aiDrafts).values(fresh));
    await expectPgError(
      inA((tx) => tx.insert(schema.aiDrafts).values({ ...fresh, id: newId() })),
      '23505',
    );
    // Superseded without a reason, or approved by nobody, is refused.
    await expectPgError(
      inA((tx) =>
        tx
          .update(schema.aiDrafts)
          .set({ state: 'superseded', decidedAt: new Date() })
          .where(eq(schema.aiDrafts.id, fresh.id)),
      ),
      '23514',
    );
    await expectPgError(
      inA((tx) =>
        tx
          .update(schema.aiDrafts)
          .set({ state: 'approved', decidedAt: new Date() })
          .where(eq(schema.aiDrafts.id, fresh.id)),
      ),
      '23514',
    );
  });

  it('keep decisions as they were made, and are never deleted by the application', async () => {
    await expectPgError(
      inA((tx) => tx.execute(sql`update ai_draft_decisions set note = 'later'`)),
      '42501',
    );
    await expectPgError(
      inA((tx) => tx.execute(sql`delete from ai_draft_decisions`)),
      '42501',
    );
    await expectPgError(
      inA((tx) => tx.execute(sql`delete from ai_drafts`)),
      '42501',
    );
  });

  it('are removed with their decisions 90 days after they ended', async () => {
    const old = await endedDraft(new Date(Date.now() - 100 * 86_400_000));
    const recent = await endedDraft(new Date(Date.now() - 10 * 86_400_000));
    const approved = await draftIn('approved');
    const decisions = () =>
      inA((tx) =>
        tx
          .select({ id: schema.aiDraftDecisions.id, draftId: schema.aiDraftDecisions.draftId })
          .from(schema.aiDraftDecisions),
      );
    expect(await decisions()).toContainEqual({ id: old.decisionId, draftId: old.id });

    expect(await purgeAiDrafts(h.app)).toBeGreaterThanOrEqual(1);
    const left = await inA((tx) => tx.select({ id: schema.aiDrafts.id }).from(schema.aiDrafts));
    const ids = left.map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
    // The old draft's decision went with it; the recent one's and the approved fixture's stay.
    const kept = await decisions();
    expect(kept.map((d) => d.id)).not.toContain(old.decisionId);
    expect(kept.map((d) => d.draftId)).not.toContain(old.id);
    expect(kept).toContainEqual({ id: recent.decisionId, draftId: recent.id });
    expect(kept.map((d) => d.draftId)).toContain(approved.id);
  });
});
