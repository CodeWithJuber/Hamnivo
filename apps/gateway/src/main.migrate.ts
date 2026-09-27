import { runMigrations } from '@hamnivo/db';

// Applies pending database migrations as the schema owner, then exits. The production compose
// file runs this once before the API and the worker start.
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is not set.');
  process.exit(1);
}
const started = Date.now();
await runMigrations(url);
process.stdout.write(`[hamnivo] database migrations applied in ${Date.now() - started} ms\n`);
