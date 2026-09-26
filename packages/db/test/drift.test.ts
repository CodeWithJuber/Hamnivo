import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

const migrations = join(import.meta.dirname, '..', 'migrations');

describe('schema ↔ migrations', () => {
  it('has a migration for every change in src/schema', async () => {
    const journal = JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const last = journal.entries.at(-1);
    if (!last) throw new Error('no migrations');
    const prefix = last.tag.split('_')[0];
    const snapshot = JSON.parse(
      readFileSync(join(migrations, 'meta', `${prefix}_snapshot.json`), 'utf8'),
    );
    const current = generateDrizzleJson(schema, snapshot.id);
    const statements = await generateMigration(snapshot, current);
    expect(
      statements,
      'Schema changed without a migration: run `pnpm --filter @hamnivo/db db:generate`',
    ).toEqual([]);
  });
});
