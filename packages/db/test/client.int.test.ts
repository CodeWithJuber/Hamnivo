import { afterAll, beforeAll, expect, it } from 'vitest';
import { closeDb, createDb } from '../src/index.js';
import { type Harness, openHarness } from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await openHarness();
});

afterAll(async () => {
  await h?.close();
});

// A server restart or a restore ends idle connections. Without a listener, node-postgres throws
// the error from an event emitter and the process stops.
it('keeps working when the server ends an idle connection', async () => {
  const lost: (string | undefined)[] = [];
  const db = createDb(h.database.app, {
    max: 1,
    onConnectionError: (error) => lost.push(error.code),
  });
  try {
    const { rows } = await db.$client.query<{ pid: number }>('select pg_backend_pid() as pid');
    await h.owner.$client.query('select pg_terminate_backend($1)', [rows[0]?.pid]);
    await expect.poll(() => lost).toEqual(['57P01']);
    const again = await db.$client.query<{ ok: number }>('select 1 as ok');
    expect(again.rows[0]?.ok).toBe(1);
  } finally {
    await closeDb(db);
  }
});
