/** Writes schema/hamnivo-migration-v1.schema.json from the Zod model. `--check` fails when stale. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageJsonSchema } from '../src/schema.js';

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema',
  'hamnivo-migration-v1.schema.json',
);
const text = `${JSON.stringify(packageJsonSchema(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== text) {
    console.error(
      'schema/hamnivo-migration-v1.schema.json is stale; run pnpm --filter @hamnivo/migration-sdk schema',
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, text);
}
