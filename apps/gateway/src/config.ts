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
  const parsed = EnvSchema.safeParse(env);
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
