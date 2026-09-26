import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Loads the repository's `.env.local` (created by scripts/setup/env.sh) when database settings
 * are not already in the environment. `pnpm ci:local` passes its own throwaway settings instead.
 */
export function loadLocalEnv(start = process.cwd()): void {
  if (process.env.DATABASE_OWNER_URL) return;
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    const file = join(dir, '.env.local');
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
