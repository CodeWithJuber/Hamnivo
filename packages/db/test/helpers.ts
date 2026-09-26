import { inject } from 'vitest';
import { closeDb, createDb, type Db } from '../src/index.js';
import { createTestDatabase, loadLocalEnv, type TestDatabase } from '../src/testing/index.js';

export interface Harness {
  database: TestDatabase;
  app: Db;
  platform: Db;
  owner: Db;
  close(): Promise<void>;
}

/** A fresh migrated database with pools for the app, platform and owner roles. */
export async function openHarness(): Promise<Harness> {
  loadLocalEnv();
  const database = await createTestDatabase(inject('templateDatabase'));
  const app = createDb(database.app, { max: 4, applicationName: 'hamnivo-test-app' });
  const platform = createDb(database.platform, {
    max: 2,
    applicationName: 'hamnivo-test-platform',
  });
  const owner = createDb(database.owner, { max: 2, applicationName: 'hamnivo-test-owner' });
  return {
    database,
    app,
    platform,
    owner,
    async close() {
      await Promise.all([closeDb(app), closeDb(platform), closeDb(owner)]);
      await database.drop();
    },
  };
}

/** PostgreSQL SQLSTATE of an error thrown by pg or wrapped by Drizzle. */
export function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = pgCode(error);
    if (actual === code) return;
    throw new Error(`Expected SQLSTATE ${code}, got ${actual ?? 'none'}: ${String(error)}`);
  }
  throw new Error(`Expected SQLSTATE ${code}, but the statement succeeded`);
}
