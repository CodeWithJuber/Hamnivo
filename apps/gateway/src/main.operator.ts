import { platformOperatorCommand } from '@hamnivo/db';

// Names a platform operator (A17), changes their role or disables them, as the database owner,
// then exits. The person signs up in Studio first. On a server that runs the production compose
// file: hamnivo.sh compose run --rm --no-deps migrate node dist/main.operator.js <email> <role>
// (or --disable instead of a role).
process.exitCode = await platformOperatorCommand(
  process.argv.slice(2),
  process.env.DATABASE_OWNER_URL,
);
