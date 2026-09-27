/**
 * Names a platform operator (A17), as the database owner:
 *   pnpm --filter @hamnivo/db platform:operator <email> <platform_admin|support_operator|platform_viewer>
 *   pnpm --filter @hamnivo/db platform:operator <email> --disable
 * The person signs up in Studio first. Uses DATABASE_OWNER_URL (environment or .env.local).
 */
import { closeDb, createDb } from '../src/client.js';
import {
  OperatorAccountMissingError,
  type PlatformOperatorRole,
  setPlatformOperator,
} from '../src/operators.js';
import { PLATFORM_OPERATOR_ROLES } from '../src/schema/operators.js';
import { loadLocalEnv } from '../src/testing/env.js';

const [email, choice] = process.argv.slice(2);
const usage = `Usage: platform:operator <email> <${PLATFORM_OPERATOR_ROLES.join('|')}|--disable>`;
if (!email || !choice) {
  console.error(usage);
  process.exit(1);
}
const disable = choice === '--disable';
if (!disable && !PLATFORM_OPERATOR_ROLES.includes(choice as PlatformOperatorRole)) {
  console.error(usage);
  process.exit(1);
}
loadLocalEnv();
const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL is not set. Run `bash scripts/setup/env.sh` first.');
  process.exit(1);
}
const owner = createDb(url, { max: 1, applicationName: 'hamnivo-platform-operator' });
try {
  const result = await setPlatformOperator(owner, {
    email,
    ...(disable ? { disable: true } : { role: choice as PlatformOperatorRole }),
  });
  console.log(`[hamnivo] ${email}: ${result.status}, ${result.role}`);
} catch (error) {
  console.error(
    error instanceof OperatorAccountMissingError || error instanceof RangeError
      ? error.message
      : error,
  );
  process.exitCode = 1;
} finally {
  await closeDb(owner);
}
