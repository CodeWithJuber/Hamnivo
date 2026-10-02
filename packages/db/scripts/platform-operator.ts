/**
 * Names a platform operator (A17), as the database owner:
 *   pnpm --filter @hamnivo/db platform:operator <email> <platform_admin|support_operator|platform_viewer>
 *   pnpm --filter @hamnivo/db platform:operator <email> --disable
 * The person signs up in Studio first. Uses DATABASE_OWNER_URL (environment or .env.local).
 * Servers that run the built images use `node dist/main.operator.js` in the gateway image.
 */
import { platformOperatorCommand } from '../src/operators.js';
import { loadLocalEnv } from '../src/testing/env.js';

loadLocalEnv();
process.exitCode = await platformOperatorCommand(
  process.argv.slice(2),
  process.env.DATABASE_OWNER_URL,
);
