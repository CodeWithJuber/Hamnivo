import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { type SSOOptions, sso } from '@better-auth/sso';
import type { Db } from '@hamnivo/db';
import { betterAuthSchema } from '@hamnivo/db/schema';
import { hash, verify } from '@node-rs/argon2';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { twoFactor } from 'better-auth/plugins';
import type { AppConfig } from '../config.js';
import type { Mailer } from '../platform/mailer.js';
import type { SsoRuntime } from './sso/sso-runtime.js';

/** Better Auth paths of the SSO plugin that are never used: SSO is managed per tenant. */
export const DISABLED_SSO_PATHS = [
  '/sso/register',
  '/sso/providers',
  '/sso/get-provider',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/sso/callback',
  '/sso/saml2/sp/metadata',
  '/sso/request-domain-verification',
  '/sso/verify-domain',
];

const SSO_REQUIRED = {
  code: 'SSO_REQUIRED',
  message: 'Your organization requires single sign-on for this address. Continue with SSO.',
};

/**
 * Staff authentication (ADR 0005) with Better Auth: email + password (argon2id), email
 * verification, TOTP two-factor with backup codes, passkeys and per-tenant OIDC single sign-on.
 * Authorization is not delegated to Better Auth; it only proves who the person is.
 *
 * Single sign-on (A13) is configured by tenants in Hamnivo, not through the plugin's own endpoints
 * (disabled here): the SSO runtime hands Better Auth the one provider a request concerns, with the
 * client secret from the secret broker, and decides who an SSO identity is. Implicit account
 * linking is off everywhere, so an identity is only ever linked where Hamnivo decided it.
 */
export function createAuth(config: AppConfig, db: Db, mailer: Mailer, runtime: SsoRuntime) {
  const secure = config.NODE_ENV === 'production';
  const consoleUrl = new URL(config.PUBLIC_CONSOLE_ORIGIN);
  const ssoOptions = {
    // The one provider the current request concerns (see SsoRuntime.run); never stored here.
    get defaultSSO() {
      return runtime.providers();
    },
    resolveUser: (input, context) => runtime.resolveUser(input, context),
    provisionUser: (data) =>
      runtime.provisionUser({
        user: { id: data.user.id, email: data.user.email, name: data.user.name },
        provider: { providerId: data.provider.providerId },
      }),
    provisionUserOnEveryLogin: true,
    // Only for new accounts: the resolver already refused anything the provider did not verify.
    trustEmailVerified: true,
    providersLimit: 0,
  } satisfies SSOOptions;
  return betterAuth({
    appName: 'Hamnivo',
    baseURL: config.PUBLIC_API_ORIGIN,
    basePath: '/api/auth',
    secret: config.BETTER_AUTH_SECRET,
    // Private identity providers the administrator allowed; everything else must be public HTTPS.
    trustedOrigins: [config.PUBLIC_CONSOLE_ORIGIN, ...config.SSO_TRUSTED_IDP_ORIGINS],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: betterAuthSchema,
      // SSO sign-ins resolve the user and create the session in one transaction.
      transaction: true,
    }),
    disabledPaths: DISABLED_SSO_PATHS,
    account: { accountLinking: { enabled: true, disableImplicitLinking: true } },
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
        // Addresses that must use SSO have no password to reset (the answer stays the same).
        if (await runtime.ssoRequired(user.email)) return;
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
    hooks: {
      // "SSO only" (A13): addresses in such a domain cannot sign in or sign up with a password.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email') return;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === 'string' && (await runtime.ssoRequired(email))) {
          throw new APIError('FORBIDDEN', SSO_REQUIRED);
        }
      }),
    },
    plugins: [
      twoFactor({ issuer: 'Hamnivo' }),
      passkey({
        rpID: consoleUrl.hostname,
        rpName: 'Hamnivo',
        origin: config.PUBLIC_CONSOLE_ORIGIN,
        authentication: {
          // …nor with a passkey: checked before any session is created.
          afterVerification: async ({ ctx, clientData }) => {
            const found = await ctx.context.adapter.findOne<{ userId: string }>({
              model: 'passkey',
              where: [{ field: 'credentialID', value: clientData.id }],
            });
            const user = found
              ? await ctx.context.internalAdapter.findUserById(found.userId)
              : null;
            if (user && (await runtime.ssoRequired(user.email))) {
              throw new APIError('FORBIDDEN', SSO_REQUIRED);
            }
          },
        },
      }),
      sso(ssoOptions),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;
