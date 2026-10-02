/**
 * Writes schema/hamnivo-migration-v1.schema.json from the Zod model. `--check` fails when stale.
 * The file is formatted by Biome like every other JSON file, so the check compares content, not
 * layout.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { packageJsonSchema } from '../src/schema.js';

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema',
  'hamnivo-migration-v1.schema.json',
);
const schema = packageJsonSchema();
if (process.argv.includes('--check')) {
  const current = existsSync(target) ? (JSON.parse(readFileSync(target, 'utf8')) as unknown) : null;
  // A round trip through JSON drops what JSON cannot hold, as the written file does.
  if (!isDeepStrictEqual(current, JSON.parse(JSON.stringify(schema)))) {
    console.error(
      'schema/hamnivo-migration-v1.schema.json is stale; run pnpm --filter @hamnivo/migration-sdk schema',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`);
  try {
    execFileSync('pnpm', ['exec', 'biome', 'format', '--write', target], { stdio: 'ignore' });
  } catch {
    console.warn('Written; format it with: pnpm exec biome format --write', target);
  }
}
