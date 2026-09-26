/** Writes openapi/hamnivo.v1.json from the route registry. `--check` fails when it is stale. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allRoutes } from '../src/routes.js';
import { buildOpenApi } from './openapi-builder.js';

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'openapi', 'hamnivo.v1.json');
const doc = `${JSON.stringify(buildOpenApi(allRoutes, '1.0.0'), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== doc) {
    console.error('openapi/hamnivo.v1.json is stale; run pnpm --filter @hamnivo/contracts openapi');
    process.exit(1);
  }
} else {
  writeFileSync(target, doc);
}
