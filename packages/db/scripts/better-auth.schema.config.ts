/**
 * Minimal Better Auth configuration used only to generate the auth tables
 * (`pnpm --filter @hamnivo/db auth:schema`). The runtime configuration lives in the gateway and
 * must enable the same plugins.
 */
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';

export const auth: { options: BetterAuthOptions } = betterAuth({
  database: drizzleAdapter({} as never, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  plugins: [twoFactor(), passkey(), sso()],
});
