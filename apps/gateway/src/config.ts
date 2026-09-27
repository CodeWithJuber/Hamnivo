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

  /** Chatwoot and the operator's Platform App token, used to provision tenant accounts. */
  CHATWOOT_URL: z.url().optional(),
  CHATWOOT_PLATFORM_TOKEN: z.string().min(8).optional(),
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

  /** The worker rewrites this file after every outbox pass (for container health checks). */
  WORKER_HEARTBEAT_FILE: z.string().min(1).optional(),

  /** Bearer token for GET /metrics; the endpoint is disabled without it. */
  METRICS_TOKEN: z.string().min(16).optional(),
  API_DOCS: bool.default(true),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(600),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  kek: { version: number; key: Buffer; retired: Map<number, Buffer> };
};

/** Parses and validates the environment once at start-up; misconfiguration stops the process. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `KEY=` in an env file means "not set", as in .env.example.
  const parsed = EnvSchema.safeParse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
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
