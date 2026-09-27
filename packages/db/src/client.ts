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
  /**
   * Called when the server ends an idle connection (a restart, a restore, a network failure). The
   * pool has already dropped it and connects again when needed. Default: one line on stderr.
   */
  onConnectionError?: (error: Error & { code?: string }) => void;
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
  // Without listeners, a connection the server ends while no query runs on it throws from an
  // event emitter and stops the process. A client in use fails its next query instead and is
  // dropped when released; the pool drops an idle one at once and reports it here. Errors while
  // the pool is closing are expected.
  const report = options.onConnectionError ?? reportConnectionError;
  pool.on('connect', (client) => client.on('error', () => {}));
  pool.on('error', (error) => {
    if (!pool.ending) report(error);
  });
  return drizzle({ client: pool, schema });
}

/** Only the code and message: the error also carries the client, with its password. */
function reportConnectionError(error: Error & { code?: string }): void {
  const code = error.code ? ` (${error.code})` : '';
  process.stderr.write(`[hamnivo] database connection lost${code}: ${error.message}\n`);
}

export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
