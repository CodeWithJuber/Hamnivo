import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Finds packages/db/migrations from wherever this module was bundled to (src/ or dist/). */
export function defaultMigrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'migrations');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Could not locate the @hamnivo/db migrations folder');
}

/**
 * Applies pending migrations as the schema owner (DATABASE_OWNER_URL). All pending migrations
 * run in one transaction, so a failure leaves the database unchanged.
 */
export async function runMigrations(
  ownerUrl: string,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  const pool = new pg.Pool({
    connectionString: ownerUrl,
    max: 1,
    application_name: 'hamnivo-migrate',
  });
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: options.migrationsFolder ?? defaultMigrationsFolder(),
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });
  } finally {
    await pool.end();
  }
}
