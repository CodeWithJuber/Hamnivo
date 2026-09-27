import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

const migrations = join(import.meta.dirname, '..', 'migrations');

function readJournal(): { entries: { tag: string; when: number }[] } {
  return JSON.parse(readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8'));
}

describe('schema ↔ migrations', () => {
  it('has a migration for every change in src/schema', async () => {
    const journal = readJournal();
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

  // Drizzle applies only migrations dated after the newest one a database has. One dated earlier
  // (say, from a branch merged late) would never run on existing servers, and a file missing from
  // the journal never runs at all. Automatic deploys run this check before a version goes live.
  it('dates every migration after the one before it, and lists every file in the journal', () => {
    const { entries } = readJournal();
    for (const [index, entry] of entries.entries()) {
      const before = entries[index - 1];
      if (before) {
        expect(entry.when, `${entry.tag} is dated before ${before.tag}`).toBeGreaterThan(
          before.when,
        );
      }
    }
    const files = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length));
    expect(files.sort()).toEqual(entries.map((entry) => entry.tag).sort());
  });
});
