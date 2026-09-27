import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { sso } from '@better-auth/sso';
import type { Db } from '@hamnivo/db';
import { betterAuthSchema } from '@hamnivo/db/schema';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import type { AppConfig } from '../config.js';
import type { Mailer } from '../platform/mailer.js';

/**
 * Staff authentication (ADR 0005) with Better Auth: email + password (argon2id), email
 * verification, TOTP two-factor with backup codes, passkeys and per-tenant OIDC/SAML SSO.
 * Authorization is not delegated to Better Auth; it only proves who the person is.
 */
export function createAuth(config: AppConfig, db: Db, mailer: Mailer) {
  const secure = config.NODE_ENV === 'production';
  const consoleUrl = new URL(config.PUBLIC_CONSOLE_ORIGIN);
  return betterAuth({
    appName: 'Hamnivo',
    baseURL: config.PUBLIC_API_ORIGIN,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.PUBLIC_CONSOLE_ORIGIN],
    database: drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      requireEmailVerification: config.REQUIRE_EMAIL_VERIFICATION,
      revokeSessionsOnPasswordReset: true,
      password: {
        // OWASP-recommended argon2id parameters (19 MiB, 2 iterations, 1 lane).
        hash: (password) => hash(password, { memoryCost: 19_456, timeCost: 2, parallelism: 1 }),
        verify: ({ hash: stored, password }) => verify(stored, password),
      },
      sendResetPassword: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          template: 'auth.reset-password',
          subject: 'Reset your Hamnivo password',
          text: `Use this link within one hour to choose a new password:\n\n${url}\n\nIf you did not ask for this, you can ignore this email.`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send({
          to: user.email,
          template: 'auth.verify-email',
          subject: 'Confirm your email for Hamnivo',
          text: `Confirm this address to finish creating your account:\n\n${url}\n\nIf you did not sign up, you can ignore this email.`,
        });
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: config.STEP_UP_MAX_AGE_MINUTES * 60,
    },
    advanced: {
      cookiePrefix: 'hamnivo',
      useSecureCookies: secure,
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true, secure },
    },
    rateLimit: { enabled: config.NODE_ENV === 'production', window: 60, max: 60 },
    plugins: [
      twoFactor({ issuer: 'Hamnivo' }),
      passkey({
        rpID: consoleUrl.hostname,
        rpName: 'Hamnivo',
        origin: config.PUBLIC_CONSOLE_ORIGIN,
      }),
      sso(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
