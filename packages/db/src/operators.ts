import { sql } from 'drizzle-orm';
import { appendPlatformAudit } from './audit.js';
import { closeDb, createDb, type Db } from './client.js';
import { newId } from './ids.js';
import { PLATFORM_OPERATOR_ROLES } from './schema/operators.js';

export type PlatformOperatorRole = (typeof PLATFORM_OPERATOR_ROLES)[number];

export class OperatorAccountMissingError extends Error {
  override name = 'OperatorAccountMissingError';
}

/**
 * Names a platform operator, changes their role or disables them (A17). Runs as the database
 * owner: the server administrator decides who may use the platform console, never the console
 * itself. The person must already have a Hamnivo account (they sign in like anyone else). The
 * change is recorded in the platform audit log.
 */
export async function setPlatformOperator(
  owner: Db,
  input: { email: string; role?: PlatformOperatorRole; disable?: boolean },
): Promise<{ id: string; role: PlatformOperatorRole; status: 'active' | 'disabled' }> {
  if (input.role && !PLATFORM_OPERATOR_ROLES.includes(input.role)) {
    throw new RangeError(`Unknown platform role: ${input.role}`);
  }
  return owner.transaction(async (tx) => {
    const { rows: users } = await tx.execute<{ id: string; name: string; email: string }>(
      sql`select id, name, email from auth."user" where lower(email) = lower(${input.email})`,
    );
    const user = users[0];
    if (!user) {
      throw new OperatorAccountMissingError(
        `No Hamnivo account uses ${input.email}. The person signs up first, then is named here.`,
      );
    }
    const { rows: existing } = await tx.execute<{ id: string; role: PlatformOperatorRole }>(
      sql`select id, role from platform_operators where auth_user_id = ${user.id}`,
    );
    const current = existing[0];
    const role = input.role ?? current?.role;
    if (!role) throw new RangeError('Name a role for a new platform operator.');
    const status = input.disable ? 'disabled' : 'active';
    const id = current?.id ?? newId();
    await tx.execute(sql`
      insert into platform_operators (id, auth_user_id, display_name, email, role, status)
      values (${id}, ${user.id}, ${user.name}, ${user.email}, ${role}, ${status})
      on conflict (auth_user_id) do update
        set role = excluded.role, status = excluded.status, display_name = excluded.display_name,
            email = excluded.email, updated_at = now()`);
    await appendPlatformAudit(tx, {
      operatorId: null,
      action: input.disable
        ? 'operator.disabled'
        : current
          ? 'operator.role_changed'
          : 'operator.appointed',
      targetType: 'platform_operator',
      targetId: id,
      outcome: 'success',
      data: { role, status, previousRole: current?.role ?? null, by: 'server_administrator' },
    });
    return { id, role, status };
  });
}

/**
 * The command line for naming platform operators, shared by the development script
 * (`pnpm --filter @hamnivo/db platform:operator`) and the gateway image
 * (`node dist/main.operator.js`): `<email> <role>` or `<email> --disable`, as the database owner.
 * Returns the process exit code.
 */
export async function platformOperatorCommand(
  args: readonly string[],
  ownerUrl: string | undefined,
  out: { log(line: string): void; error(line: string): void } = console,
): Promise<number> {
  const [email, choice] = args;
  const roles: readonly string[] = PLATFORM_OPERATOR_ROLES;
  if (!email || !choice || (choice !== '--disable' && !roles.includes(choice))) {
    out.error(`Usage: <email> <${roles.join('|')}|--disable>`);
    return 1;
  }
  if (!ownerUrl) {
    out.error('DATABASE_OWNER_URL is not set.');
    return 1;
  }
  const owner = createDb(ownerUrl, { max: 1, applicationName: 'hamnivo-platform-operator' });
  try {
    const result = await setPlatformOperator(owner, {
      email,
      ...(choice === '--disable' ? { disable: true } : { role: choice as PlatformOperatorRole }),
    });
    out.log(`[hamnivo] ${email}: ${result.status}, ${result.role}`);
    return 0;
  } catch (error) {
    if (error instanceof OperatorAccountMissingError || error instanceof RangeError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await closeDb(owner);
  }
}
