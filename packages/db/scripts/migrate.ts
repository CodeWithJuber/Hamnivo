/**
 * Applies database migrations as the schema owner.
 *   pnpm db:migrate            uses DATABASE_OWNER_URL (from the environment or .env.local)
 */

import { runMigrations } from '../src/migrate.js';
import { loadLocalEnv } from '../src/testing/env.js';

loadLocalEnv();
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is not set. Run `bash scripts/setup/env.sh` first.');
  process.exit(1);
}
const started = Date.now();
await runMigrations(url);
const target = new URL(url);
console.log(
  `[hamnivo] migrations applied to ${target.hostname}:${target.port || 5432}${target.pathname} in ${Date.now() - started} ms`,
);
