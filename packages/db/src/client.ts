import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema> & { $client: pg.Pool };

export interface DbOptions {
  /** Maximum pool size (default 10). */
  max?: number;
  /** Shown in pg_stat_activity; helps attribute load to gateway vs worker. */
  applicationName?: string;
  idleTimeoutMs?: number;
}

/**
 * Creates a pooled Drizzle client for one database role. The gateway and worker use the
 * `hamnivo_app` role (DATABASE_URL); the platform console uses `hamnivo_platform`.
 */
export function createDb(connectionString: string, options: DbOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'hamnivo',
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
  });
  return drizzle({ client: pool, schema });
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
