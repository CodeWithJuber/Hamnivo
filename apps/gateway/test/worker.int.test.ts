import {
  type ClaimedOutboxEvent,
  closeDb,
  createDb,
  type Db,
  fromPublicId,
  schema,
  withTenant,
} from '@hamnivo/db';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { OutboxRelay } from '../src/outbox/relay.service.js';
import { MaintenanceService } from '../src/worker/maintenance.service.js';
import { WorkerModule } from '../src/worker.module.js';
import { type Gateway, signUp, startGateway, testEnv } from './harness.js';

let gw: Gateway;
let worker: INestApplicationContext;
let db: Db;
const handled: ClaimedOutboxEvent[] = [];
let failNext = false;

beforeAll(async () => {
  gw = await startGateway();
  const config = loadConfig(
    testEnv(gw.database, { BETTER_AUTH_SECRET: gw.config.BETTER_AUTH_SECRET }),
  );
  worker = await NestFactory.createApplicationContext(
    WorkerModule.forRoot(config, {
      handlers: new Map([
        [
          'tenant.created',
          async (event: ClaimedOutboxEvent) => {
            if (failNext) {
              failNext = false;
              throw new Error('provisioning backend unavailable');
            }
            handled.push(event);
          },
        ],
      ]),
    }),
    { logger: false },
  );
  // Drive the relay by hand for deterministic tests.
  await worker.get(OutboxRelay).onApplicationShutdown();
  db = createDb(gw.database.app, { max: 1 });
});

afterAll(async () => {
  await worker?.close();
  if (db) await closeDb(db);
  await gw?.close();
});

describe('outbox relay', () => {
  it('delivers tenant.created once and acknowledges it inside the tenant', async () => {
    const owner = await signUp(gw, 'Relay Owner', 'relay@example.com');
    const tenant = (await owner.post('/v1/tenants', { name: 'Relay Co', slug: 'relay-co' })).body
      .tenant.id;
    const tenantId = fromPublicId('tenant', tenant);

    const relay = worker.get(OutboxRelay);
    expect(await relay.drainOnce()).toBe(1);
    expect(handled.map((e) => e.aggregateId)).toEqual([tenantId]);
    expect(await relay.drainOnce()).toBe(0);
    const [row] = await withTenant(db, { tenantId }, (tx) => tx.select().from(schema.outboxEvents));
    expect(row?.processedAt).not.toBeNull();
  });

  it('backs off after a failure and delivers on a later attempt', async () => {
    const owner = await signUp(gw, 'Retry Owner', 'retry@example.com');
    const tenantId = fromPublicId(
      'tenant',
      (await owner.post('/v1/tenants', { name: 'Retry Co', slug: 'retry-co' })).body.tenant.id,
    );
    failNext = true;
    const relay = worker.get(OutboxRelay);
    expect(await relay.drainOnce()).toBe(1);
    const [failed] = await withTenant(db, { tenantId }, (tx) =>
      tx.select().from(schema.outboxEvents),
    );
    expect(failed?.processedAt).toBeNull();
    expect(failed?.lastError).toBe('provisioning backend unavailable');
    expect(failed?.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await relay.drainOnce()).toBe(0);

    // Make it due again (as time passing would) and let the relay retry.
    await withTenant(db, { tenantId }, (tx) =>
      tx
        .update(schema.outboxEvents)
        .set({ availableAt: new Date(Date.now() - 1000) })
        .where(eq(schema.outboxEvents.tenantId, tenantId)),
    );
    expect(await relay.drainOnce()).toBe(1);
    expect(handled.at(-1)?.aggregateId).toBe(tenantId);
    expect(handled.at(-1)?.attempts).toBe(2);
  });
});

describe('maintenance jobs', () => {
  it('keeps audit partitions ahead and purges expired rows', async () => {
    const maintenance = worker.get(MaintenanceService);
    // The job scheduler may already have run once at start-up; the outcome is what matters.
    await maintenance.run('audit-partitions');
    expect(await maintenance.run('audit-partitions')).toEqual({ created: 0 });
    const now = new Date();
    const ahead = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));
    const name = `audit_events_y${ahead.getUTCFullYear()}m${String(ahead.getUTCMonth() + 1).padStart(2, '0')}`;
    const { rows } = await gw.owner.execute<{ exists: boolean }>(
      sql`select to_regclass(${name}) is not null as exists`,
    );
    expect(rows[0]?.exists).toBe(true);
    expect(await maintenance.run('purge-expired')).toMatchObject({ conversation_journal: 0 });
  });
});
