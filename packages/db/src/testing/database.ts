import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../migrate.js';

export interface DatabaseUrls {
  owner: string;
  app: string;
  platform: string;
}

export interface TestDatabase extends DatabaseUrls {
  name: string;
  drop(): Promise<void>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Run \`bash scripts/setup/env.sh && pnpm services:up\` or use \`pnpm ci:local\`.`,
    );
  }
  return value;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Base connection URLs for the three login roles, from the environment. */
export function databaseUrlsFromEnv(): DatabaseUrls {
  return {
    owner: required('DATABASE_OWNER_URL'),
    app: required('DATABASE_URL'),
    platform: required('DATABASE_PLATFORM_URL'),
  };
}

const SAFE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

async function onMaintenanceDb(ownerUrl: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString: withDatabase(ownerUrl, 'postgres') });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * Builds a migrated template database once per test run (Vitest globalSetup). It is cloned from
 * `hamnivo_test`, which deploy/postgres/init.sh prepared with the required extensions.
 */
export async function prepareTemplateDatabase(name: string): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe database name: ${name}`);
  const { owner } = databaseUrlsFromEnv();
  const base = process.env.HAMNIVO_TEST_BASE_DATABASE ?? 'hamnivo_test';
  if (!SAFE_NAME.test(base)) throw new Error(`Unsafe database name: ${base}`);
  await onMaintenanceDb(owner, [
    `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
    `CREATE DATABASE ${name} TEMPLATE ${base}`,
  ]);
  await runMigrations(withDatabase(owner, name));
}

export async function dropDatabase(name: string): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new Error(`Unsafe database name: ${name}`);
  await onMaintenanceDb(databaseUrlsFromEnv().owner, [
    `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
  ]);
}

/** A fresh, fully migrated database for one test file, cloned from the template. */
export async function createTestDatabase(template: string): Promise<TestDatabase> {
  if (!SAFE_NAME.test(template)) throw new Error(`Unsafe database name: ${template}`);
  const urls = databaseUrlsFromEnv();
  const name = `hamnivo_t_${randomBytes(6).toString('hex')}`;
  await onMaintenanceDb(urls.owner, [`CREATE DATABASE ${name} TEMPLATE ${template}`]);
  return {
    name,
    owner: withDatabase(urls.owner, name),
    app: withDatabase(urls.app, name),
    platform: withDatabase(urls.platform, name),
    drop: () => dropDatabase(name),
  };
}
