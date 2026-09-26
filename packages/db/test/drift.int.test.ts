import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, createDb, type Db } from '../src/index.js';
import * as schema from '../src/schema/index.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { type Harness, openHarness } from './helpers.js';

/**
 * The migrations include hand-written SQL (foundations, partitioning, security). This test builds
 * a second database straight from src/schema and compares both catalogs as PostgreSQL normalizes
 * them, so any divergence between the SQL files and the TypeScript schema fails the build.
 */

let migrated: Harness;
let fromSchema: TestDatabase;
let fromSchemaDb: Db;

const migrationsDir = join(import.meta.dirname, '..', 'migrations');

async function applySqlFile(db: Db, file: string) {
  const text = readFileSync(join(migrationsDir, file), 'utf8');
  for (const statement of text.split('--> statement-breakpoint')) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

async function catalog(db: Db) {
  const tables = sql`(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition)`;
  const columns = await db.execute<Record<string, unknown>>(sql`
    select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
           a.attnotnull as not_null, pg_get_expr(d.adbin, d.adrelid) as default
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid in ${tables} and a.attnum > 0 and not a.attisdropped
    order by 1, 2`);
  const constraints = await db.execute<Record<string, unknown>>(sql`
    select conrelid::regclass::text as table, conname as name, pg_get_constraintdef(oid) as def
    from pg_constraint where conrelid in ${tables} order by 1, 2`);
  const indexes = await db.execute<{ table: string; name: string; def: string }>(sql`
    select i.indrelid::regclass::text as table, i.indexrelid::regclass::text as name,
           pg_get_indexdef(i.indexrelid) as def
    from pg_index i where i.indrelid in ${tables} order by 1, 2`);
  const policies = await db.execute<Record<string, unknown>>(sql`
    select tablename as table, policyname as name, permissive, roles::text[] as roles, cmd, qual,
           with_check
    from pg_policies where schemaname = 'public' order by 1, 2`);
  const rls = await db.execute<Record<string, unknown>>(sql`
    select relname as table, relrowsecurity as enabled from pg_class where oid in ${tables}
    order by 1`);
  return {
    columns: columns.rows,
    constraints: constraints.rows,
    // A partitioned parent's indexes print as "ON ONLY"; partitioning is intentional.
    indexes: indexes.rows.map((r) => ({ ...r, def: r.def.replace(' ON ONLY ', ' ON ') })),
    policies: policies.rows,
    rls: rls.rows,
  };
}

beforeAll(async () => {
  migrated = await openHarness();
  fromSchema = await createTestDatabase(process.env.HAMNIVO_TEST_BASE_DATABASE ?? 'hamnivo_test');
  fromSchemaDb = createDb(fromSchema.owner, { max: 1 });
  const foundations = readdirSync(migrationsDir).find((f) => f.endsWith('_foundations.sql'));
  if (!foundations) throw new Error('foundations migration not found');
  await applySqlFile(fromSchemaDb, foundations);
  const empty = generateDrizzleJson({});
  const statements = await generateMigration(empty, generateDrizzleJson(schema, empty.id));
  for (const statement of statements) await fromSchemaDb.execute(sql.raw(statement));
});

afterAll(async () => {
  if (fromSchemaDb) await closeDb(fromSchemaDb);
  await fromSchema?.drop();
  await migrated?.close();
});

describe('migrated database ↔ src/schema', () => {
  it('has the same tables, columns, constraints, indexes and policies', async () => {
    const expected = await catalog(fromSchemaDb);
    const actual = await catalog(migrated.owner);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.policies).toEqual(expected.policies);
    expect(actual.rls).toEqual(expected.rls);
  });
});
