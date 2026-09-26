import pg from 'pg';
import type { TestProject } from 'vitest/node';
import {
  databaseUrlsFromEnv,
  dropDatabase,
  loadLocalEnv,
  prepareTemplateDatabase,
  withDatabase,
} from '../src/testing/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

/** Fails fast when the tests would run against a different server than the caller intended. */
async function assertServer() {
  const client = new pg.Client({
    connectionString: withDatabase(databaseUrlsFromEnv().owner, 'postgres'),
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ v: string; version: string }>(
      `select current_setting('server_version_num') as v, current_setting('server_version') as version`,
    );
    const major = Math.floor(Number(rows[0]?.v) / 10000);
    const expected = process.env.HAMNIVO_PG_MAJOR;
    if (expected && Number(expected) !== major) {
      throw new Error(
        `Expected PostgreSQL ${expected}, but the test server runs ${rows[0]?.version}`,
      );
    }
    const url = new URL(databaseUrlsFromEnv().owner);
    process.stdout.write(
      `[hamnivo] integration tests on PostgreSQL ${rows[0]?.version} at ${url.hostname}:${url.port}\n`,
    );
  } finally {
    await client.end();
  }
}

/** Migrates one template database per run; each test file clones it (fast, isolated). */
export default async function setup(project: TestProject) {
  loadLocalEnv();
  await assertServer();
  const template = `hamnivo_tpl_db_${process.pid}`;
  await prepareTemplateDatabase(template);
  project.provide('templateDatabase', template);
  return async () => {
    await dropDatabase(template);
  };
}
