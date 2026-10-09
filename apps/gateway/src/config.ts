import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_PLATFORM_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  /** 32-byte key-encryption key (base64) for stored secrets, and its version number. */
  HAMNIVO_KEK_BASE64: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  HAMNIVO_KEK_VERSION: z.coerce.number().int().min(1).default(1),
  /** Earlier keys still needed to decrypt, as `version:base64` pairs separated by commas. */
  HAMNIVO_KEK_RETIRED: z.string().default(''),

  BETTER_AUTH_SECRET: z.string().min(32),
  PUBLIC_API_ORIGIN: z.url().default('http://localhost:4000'),
  PUBLIC_CONSOLE_ORIGIN: z.url().default('http://localhost:5173'),
  REQUIRE_EMAIL_VERIFICATION: bool.default(true),
  /** Minutes a sign-in stays "fresh" for step-up actions. */
  STEP_UP_MAX_AGE_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  /**
   * Identity-provider origins on a private network that tenants may use for single sign-on,
   * comma-separated (e.g. `https://idp.corp.internal`). Every other provider must use HTTPS on a
   * publicly routable address; the server never fetches private addresses for a tenant.
   */
  SSO_TRUSTED_IDP_ORIGINS: z
    .string()
    .default('')
    .transform((value, ctx) => {
      const origins: string[] = [];
      for (const entry of value.split(',').map((origin) => origin.trim())) {
        if (!entry) continue;
        if (!URL.canParse(entry)) {
          ctx.addIssue({ code: 'custom', message: `not a URL: ${entry}` });
          continue;
        }
        origins.push(new URL(entry).origin);
      }
      return origins;
    }),
  /** DNS servers for domain verification (`ip` or `ip:port`, comma-separated); default: system. */
  SSO_DNS_SERVERS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((server) => server.trim())
        .filter(Boolean),
    ),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Hamnivo <no-reply@hamnivo.local>'),

  /** Origin that serves the chat widget iframe (allowed to call /v1/widget/* from browsers). */
  PUBLIC_WIDGET_ORIGIN: z.url().default('http://localhost:5174'),
  /** ES256 private key (PKCS#8 PEM, base64) that signs widget access tokens. */
  WIDGET_SIGNING_KEY: z.string().optional(),
  WIDGET_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(15),
  WIDGET_SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Seconds between stream heartbeats (each one also re-checks the session). */
  STREAM_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(60).default(15),
  /** Days a realtime journal entry stays replayable (it is a projection, not a transcript). */
  JOURNAL_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  /**
   * Seconds a reply waits unread before a customer who asked for it gets an email (W25). The
   * same conversation emails at most once in 30 minutes.
   */
  CUSTOMER_REPLY_EMAIL_DELAY_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

  /** Chatwoot and the operator's Platform App token, used to provision tenant accounts. */
  CHATWOOT_URL: z.url().optional(),
  CHATWOOT_PLATFORM_TOKEN: z.string().min(8).optional(),
  /**
   * Chatwoot's public address, where Meta and Telegram deliver channel messages (its
   * FRONTEND_URL); defaults to CHATWOOT_URL when the gateway reaches Chatwoot the same way.
   */
  CHATWOOT_PUBLIC_URL: z.url().optional(),
  /** Base URL Chatwoot uses to reach this gateway's webhook endpoints (default PUBLIC_API_ORIGIN). */
  CHATWOOT_WEBHOOK_BASE_URL: z.url().optional(),
  /** Chatwoot request timeout in milliseconds. */
  CHATWOOT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),

  /**
   * Platform model keys. Agents that name no tenant connection use these; without one, an agent
   * using that provider cannot be published. `hamnivo-mock` needs no key.
   */
  ANTHROPIC_API_KEY: z.string().min(8).optional(),
  OPENAI_API_KEY: z.string().min(8).optional(),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().min(8).optional(),
  OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().min(1).optional(),

  /** Embeddings for knowledge search; `mock` is deterministic and offline. */
  EMBEDDING_PROVIDER: z.enum(['mock', 'openai', 'google', 'openai-compatible']).default('mock'),
  EMBEDDING_MODEL: z.string().min(1).default('hamnivo-embed'),
  /** ClamAV daemon for uploads (tcp://host:3310). Without it only the EICAR test file is caught. */
  CLAMAV_URL: z.url().optional(),
  /**
   * Websites kept as knowledge are read one request at a time, at least this long apart (the
   * site's robots.txt may ask for longer). Raise it for a small server; `0` only for tests.
   */
  KNOWLEDGE_WEB_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(1000),

  /** Messages per minute written into one conversation while importing (Chatwoot allows 200). */
  MIGRATION_MESSAGES_PER_MINUTE: z.coerce.number().int().min(1).max(200).default(180),
  /** One worker pass works on an import for at most this long, then hands over to the next. */
  MIGRATION_SLICE_SECONDS: z.coerce.number().int().min(1).max(300).default(20),
  /** …and for at most this many conversations. */
  MIGRATION_SLICE_CONVERSATIONS: z.coerce.number().int().min(1).max(10_000).default(200),
  /** Days an uploaded export is kept after its job ends (samples and retries need it). */
  MIGRATION_EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  /** Conversations one import reads from a Chatwoot source; the next import continues. */
  MIGRATION_SOURCE_MAX_CONVERSATIONS: z.coerce.number().int().min(1).max(10_000).default(1000),
  /**
   * Lets imports read a source at a loopback or private address (development and tests only):
   * otherwise source URLs must be https and public, checked again on every connection.
   */
  MIGRATION_SOURCE_ALLOW_PRIVATE: bool.default(false),

  /**
   * Jev (TypeSafe) for routing decisions. Without a key, rubrics that name Jev record every
   * decision as unavailable and the deterministic baseline decides. Set as TYPESAFE_API_KEY and
   * TYPESAFE_BASE_URL, the names TypeSafe's SDK and docs use; JEV_API_KEY and JEV_BASE_URL are
   * still read when those are unset.
   */
  JEV_API_KEY: z.string().min(8).optional(),
  JEV_BASE_URL: z.url().optional(),

  /** Prefix of every cache key in Valkey; separate deployments and test runs use their own. */
  CACHE_KEY_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:_-]{1,64}$/)
    .default('hv:cache:'),
  /** Deadline of one cache operation; slower answers count as misses (fail open). */
  CACHE_TIMEOUT_MS: z.coerce.number().int().min(10).max(2000).default(150),

  /**
   * Commerce (C01–C12). Another Stripe API origin, such as stripe-mock or a fake server: tests and
   * local demos only, refused in production.
   */
  COMMERCE_STRIPE_API_BASE: z.url().optional(),
  /** Payment-provider request timeout; a write that times out is reconciled, never resent blindly. */
  COMMERCE_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(200).max(60_000).default(10_000),
  /** Minutes a hosted payment page stays open (Stripe allows 30 minutes to 24 hours). */
  COMMERCE_CHECKOUT_MINUTES: z.coerce.number().int().min(30).max(1440).default(60),
  /** Allows `mock` merchant connections (in-memory store) outside development and tests. */
  COMMERCE_ALLOW_MOCK: bool.default(false),

  /**
   * AI actions (G07–G15, D10). The demo tools (address change, store credit) use an in-memory
   * stand-in for a merchant's order service and are offered outside production only, unless this
   * is set (demos).
   */
  TOOLS_ALLOW_DEMO: bool.default(false),
  /**
   * Lets MCP servers be reached over plain HTTP on private addresses (loopback test servers).
   * Development and tests only: refused in production.
   */
  TOOLS_EGRESS_ALLOW_PRIVATE: bool.default(false),
  /** Tool calls of one run that may run at the same time (X03). */
  TOOLS_MAX_PARALLEL: z.coerce.number().int().min(1).max(10).default(3),

  /** The worker rewrites this file after every outbox pass (for container health checks). */
  WORKER_HEARTBEAT_FILE: z.string().min(1).optional(),

  /** Bearer token for GET /metrics; the endpoint is disabled without it. */
  METRICS_TOKEN: z.string().min(16).optional(),
  API_DOCS: bool.default(true),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
  /** Requests per minute for one API key (each key has its own budget). */
  API_KEY_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  /** Tool calls per minute for one API key on the MCP server, on top of the budget above. */
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(30),

  /**
   * Outbound requests made for tenants (webhooks) reach public HTTPS hosts only. Origins listed
   * here (comma-separated, e.g. `http://10.0.0.5:8080`) are trusted by the server administrator:
   * reachable on a private network and over plain HTTP. Leave empty in production unless needed.
   */
  EGRESS_TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((value, ctx) => {
      const origins = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      for (const origin of origins) {
        let parsed: URL | null = null;
        try {
          parsed = new URL(origin);
        } catch {
          parsed = null;
        }
        if (!parsed || parsed.origin !== origin) {
          ctx.addIssue({ code: 'custom', message: `not an origin: ${origin}` });
        }
      }
      return origins;
    }),
  /** Webhook request deadline (the Standard Webhooks advice is 15 to 30 seconds). */
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(15_000),
  /** Days an event body is kept, so failed deliveries can be replayed. */
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Days the delivery log (without bodies) is kept. */
  WEBHOOK_LOG_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  /**
   * An endpoint is turned off after this many failed attempts in a row that span at least
   * WEBHOOK_DISABLE_AFTER_HOURS; the owner can turn it on again and replay what failed.
   */
  WEBHOOK_DISABLE_AFTER_FAILURES: z.coerce.number().int().min(1).max(1000).default(10),
  WEBHOOK_DISABLE_AFTER_HOURS: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 30)
    .default(72),
  /** Webhook requests sent at the same time by one worker. */
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  /** Analytics withhold values computed from fewer conversations or responses than this. */
  ANALYTICS_MIN_GROUP_SIZE: z.coerce.number().int().min(2).max(50).default(5),
  /** Days between issuing a platform invoice and its due date. */
  BILLING_INVOICE_DUE_DAYS: z.coerce.number().int().min(1).max(90).default(14),

  /**
   * SaaS. Anyone may create an account and a workspace; the platform console can override it.
   * When off, only people with an invitation may sign up (the first account of a server always).
   */
  HAMNIVO_PUBLIC_SIGNUP: bool.default(true),
  /** The plan every new workspace starts on, or `unlimited` for no plan (self-hosting). */
  HAMNIVO_DEFAULT_PLAN: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .default('free'),
  /** Cloudflare Turnstile on sign-up; off unless both keys are set. */
  TURNSTILE_SITE_KEY: z.string().min(1).optional(),
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
  /** Another Turnstile verification URL: tests only, refused in production. */
  TURNSTILE_VERIFY_URL: z.url().optional(),
  /** Who bills workspaces: nobody (`free`), Stripe Billing or WHMCS. */
  BILLING_PROVIDER: z.enum(['free', 'stripe', 'whmcs']).default('free'),
  STRIPE_SECRET_KEY: z.string().min(8).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(8).optional(),
  /** Another Stripe API origin (stripe-mock, a fake server): tests only, refused in production. */
  STRIPE_API_BASE: z.url().optional(),
  /** Days a workspace keeps its paid plan after a failed payment, then falls back to free. */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  /** The WHMCS client area, where Studio's Manage button sends WHMCS customers. */
  WHMCS_CLIENT_AREA_URL: z.url().optional(),
  /** Sets up a brand's Chatwoot account by itself (first brand of a workspace). */
  CHATWOOT_AUTO_PROVISION: bool.default(true),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  kek: { version: number; key: Buffer; retired: Map<number, Buffer> };
};

/** Parses and validates the environment once at start-up; misconfiguration stops the process. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `KEY=` in an env file means "not set", as in .env.example.
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  // TypeSafe's own names for the Jev key and endpoint come first.
  set.JEV_API_KEY = set.TYPESAFE_API_KEY ?? set.JEV_API_KEY;
  set.JEV_BASE_URL = set.TYPESAFE_BASE_URL ?? set.JEV_BASE_URL;
  const parsed = EnvSchema.safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.COMMERCE_STRIPE_API_BASE) {
    throw new Error('Invalid configuration:\n  COMMERCE_STRIPE_API_BASE is for tests only');
  }
  if (parsed.data.NODE_ENV === 'production' && parsed.data.TOOLS_EGRESS_ALLOW_PRIVATE) {
    throw new Error('Invalid configuration:\n  TOOLS_EGRESS_ALLOW_PRIVATE is for tests only');
  }
  for (const key of ['STRIPE_API_BASE', 'TURNSTILE_VERIFY_URL'] as const) {
    if (parsed.data.NODE_ENV === 'production' && parsed.data[key]) {
      throw new Error(`Invalid configuration:\n  ${key} is for tests only`);
    }
  }
  if (Boolean(parsed.data.TURNSTILE_SITE_KEY) !== Boolean(parsed.data.TURNSTILE_SECRET_KEY)) {
    throw new Error(
      'Invalid configuration:\n  set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither',
    );
  }
  if (
    parsed.data.BILLING_PROVIDER === 'stripe' &&
    (!parsed.data.STRIPE_SECRET_KEY || !parsed.data.STRIPE_WEBHOOK_SECRET)
  ) {
    throw new Error(
      'Invalid configuration:\n  BILLING_PROVIDER=stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET',
    );
  }
  const retired = new Map<number, Buffer>();
  for (const pair of parsed.data.HAMNIVO_KEK_RETIRED.split(',').filter(Boolean)) {
    const [version, key] = pair.split(':');
    const bytes = Buffer.from(key ?? '', 'base64');
    if (!version || bytes.length !== 32)
      throw new Error('HAMNIVO_KEK_RETIRED must be version:base64 pairs');
    retired.set(Number(version), bytes);
  }
  return {
    ...parsed.data,
    kek: {
      version: parsed.data.HAMNIVO_KEK_VERSION,
      key: Buffer.from(parsed.data.HAMNIVO_KEK_BASE64, 'base64'),
      retired,
    },
  };
}
