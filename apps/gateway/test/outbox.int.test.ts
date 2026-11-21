import type { ClaimedOutboxEvent } from '@hamnivo/db';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueueOutbox, OUTBOX_SIGNAL } from '../src/outbox/outbox.js';
import { type OutboxHandler, OutboxRelay } from '../src/outbox/relay.service.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * The worker's outbox pump on the real database: a slow job in one conversation does not hold
 * up another conversation's reply, each conversation's own jobs stay in order, and a commit's
 * signal starts the work at once.
 */
let slice: Slice;
let tenantId: string;
let redis: Redis;
const TOPIC = 'test.outbox_pump';

beforeAll(async () => {
  slice = await startSlice();
  const shop = await connectedTenant(slice, 'pump', { publishAgent: false });
  tenantId = fromPublicId('tenant', shop.tenantId);
  redis = new Redis(slice.gw.config.REDIS_URL, { maxRetriesPerRequest: null });
});

afterAll(async () => {
  await redis?.quit();
  await slice?.close();
});

/** Queues one test event per conversation and step, in this order. */
async function queue(steps: Array<[conversation: string, step: string]>): Promise<string[]> {
  return withTenant(slice.app, { tenantId }, async (tx) => {
    for (const [conversation, step] of steps) {
      await enqueueOutbox(tx, tenantId, {
        topic: TOPIC,
        aggregateType: 'conversation',
        aggregateId: conversation,
        payload: { step },
      });
    }
    // Earlier tests' events are all processed by the time a test queues more.
    const rows = await tx
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(and(eq(schema.outboxEvents.topic, TOPIC), isNull(schema.outboxEvents.processedAt)));
    return rows.map((row) => row.id);
  });
}

async function processed(ids: string[]): Promise<number> {
  const rows = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ id: schema.outboxEvents.id, at: schema.outboxEvents.processedAt })
      .from(schema.outboxEvents)
      .where(inArray(schema.outboxEvents.id, ids)),
  );
  return rows.filter((row) => row.at !== null).length;
}

/** A relay of its own, with the given handler for the test topic and the given slots. */
function relayWith(handler: OutboxHandler, slots: number): OutboxRelay {
  const base = slice.worker.get(OutboxRelay) as unknown as {
    db: ConstructorParameters<typeof OutboxRelay>[0];
    clock: ConstructorParameters<typeof OutboxRelay>[2];
    config: ConstructorParameters<typeof OutboxRelay>[3];
  };
  return new OutboxRelay(
    base.db,
    new Map([[TOPIC, handler]]),
    base.clock,
    { ...base.config, OUTBOX_CONCURRENCY: slots },
    redis,
  );
}

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('the outbox pump', () => {
  it('lets other conversations through while one job is slow, and keeps each one in order', async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = relayWith(async (event: ClaimedOutboxEvent) => {
      const step = String((event.payload as { step: string }).step);
      seen.push(`start ${step}`);
      if (step === 'a1') await slow;
      seen.push(`end ${step}`);
    }, 4);
    const ids = await queue([
      ['conv-a', 'a1'],
      ['conv-a', 'a2'],
      ['conv-b', 'b1'],
      ['conv-c', 'c1'],
    ]);
    await relay.onApplicationBootstrap();
    try {
      // b1 and c1 finish while a1 is still running; a2 has not started. A handler returns before
      // the relay records its event, so the check waits for both records, not for the handlers.
      await until(async () => seen.includes('end b1') && seen.includes('end c1'));
      await until(async () => (await processed(ids)) === 2);
      expect(seen).not.toContain('start a2');
      expect(await processed(ids)).toBe(2);
      release();
      await until(async () => (await processed(ids)) === 4);
      expect(seen.indexOf('end a1')).toBeLessThan(seen.indexOf('start a2'));
    } finally {
      release();
      await relay.onApplicationShutdown();
    }
  });

  it('starts at once on a commit’s signal instead of waiting for its next look', async () => {
    let ran = 0;
    const relay = relayWith(async () => {
      ran += 1;
    }, 2);
    await relay.onApplicationBootstrap();
    try {
      // Let its first look find nothing; the next one would be a second away.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const ids = await queue([['conv-d', 'd1']]);
      const started = Date.now();
      await redis.publish(OUTBOX_SIGNAL, tenantId);
      await until(async () => (await processed(ids)) === 1, 5_000);
      expect(ran).toBe(1);
      expect(Date.now() - started).toBeLessThan(900);
    } finally {
      await relay.onApplicationShutdown();
    }
  });

  it('hands back what waits when it stops, so another worker takes it at once', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const relay = relayWith(async () => {
      await slow;
    }, 1);
    const ids = await queue([
      ['conv-e', 'e1'],
      ['conv-f', 'f1'],
    ]);
    await relay.onApplicationBootstrap();
    await until(async () => {
      const rows = await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .select({ locked: schema.outboxEvents.lockedUntil })
          .from(schema.outboxEvents)
          .where(inArray(schema.outboxEvents.id, ids)),
      );
      return rows.every((row) => row.locked !== null);
    });
    const stopping = relay.onApplicationShutdown();
    // The waiting event is released before the running one is finished.
    await until(async () => {
      const rows = await withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .select({
            locked: schema.outboxEvents.lockedUntil,
            done: schema.outboxEvents.processedAt,
          })
          .from(schema.outboxEvents)
          .where(inArray(schema.outboxEvents.id, ids)),
      );
      return rows.some((row) => row.locked === null && row.done === null);
    });
    release();
    await stopping;
    expect(await processed(ids)).toBe(1);
    // The released one is still due; the slice's own relay finishes it.
    expect(await slice.worker.get(OutboxRelay).drainOnce()).toBeGreaterThanOrEqual(1);
  });
});
