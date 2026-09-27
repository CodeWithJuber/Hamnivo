import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Better Auth tables (staff sign-in: password, TOTP, passkeys, OIDC/SAML SSO), generated with
 * `auth generate` for the plugins enabled in the gateway and moved into the `auth` schema.
 * People are global (one person can be staff in several tenants), so these tables are not
 * tenant-scoped; tenant membership lives in public.staff_members. Only hamnivo_app can use them.
 */
export const authSchema = pgSchema('auth');

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const authUser = authSchema.table('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: tz('created_at').defaultNow().notNull(),
  updatedAt: tz('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
  twoFactorEnabled: boolean('two_factor_enabled').default(false),
});

export const authSession = authSchema.table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: tz('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: tz('created_at').defaultNow().notNull(),
    updatedAt: tz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const authAccount = authSchema.table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: tz('access_token_expires_at'),
    refreshTokenExpiresAt: tz('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: tz('created_at').defaultNow().notNull(),
    updatedAt: tz('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const authVerification = authSchema.table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tz('expires_at').notNull(),
    createdAt: tz('created_at').defaultNow().notNull(),
    updatedAt: tz('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

export const authTwoFactor = authSchema.table(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    verified: boolean('verified').default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: tz('locked_until'),
  },
  (t) => [
    index('two_factor_secret_idx').on(t.secret),
    index('two_factor_user_id_idx').on(t.userId),
  ],
);

export const authPasskey = authSchema.table(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: tz('created_at'),
    aaguid: text('aaguid'),
  },
  (t) => [
    index('passkey_user_id_idx').on(t.userId),
    index('passkey_credential_id_idx').on(t.credentialID),
  ],
);

export const authSsoProvider = authSchema.table('sso_provider', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  oidcConfig: text('oidc_config'),
  samlConfig: text('saml_config'),
  userId: text('user_id')
    .notNull()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull().unique(),
  organizationId: text('organization_id'),
  domain: text('domain').notNull(),
});

export const authUserRelations = relations(authUser, ({ many }) => ({
  sessions: many(authSession),
  accounts: many(authAccount),
  twoFactors: many(authTwoFactor),
  passkeys: many(authPasskey),
  ssoProviders: many(authSsoProvider),
}));

export const authSessionRelations = relations(authSession, ({ one }) => ({
  user: one(authUser, { fields: [authSession.userId], references: [authUser.id] }),
}));

export const authAccountRelations = relations(authAccount, ({ one }) => ({
  user: one(authUser, { fields: [authAccount.userId], references: [authUser.id] }),
}));

export const authTwoFactorRelations = relations(authTwoFactor, ({ one }) => ({
  user: one(authUser, { fields: [authTwoFactor.userId], references: [authUser.id] }),
}));

export const authPasskeyRelations = relations(authPasskey, ({ one }) => ({
  user: one(authUser, { fields: [authPasskey.userId], references: [authUser.id] }),
}));

export const authSsoProviderRelations = relations(authSsoProvider, ({ one }) => ({
  user: one(authUser, { fields: [authSsoProvider.userId], references: [authUser.id] }),
}));

/** Model map for `drizzleAdapter(db, { provider: 'pg', schema: betterAuthSchema })`. */
export const betterAuthSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  twoFactor: authTwoFactor,
  passkey: authPasskey,
  ssoProvider: authSsoProvider,
};
