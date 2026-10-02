import type { CacheStore } from '@hamnivo/adapters/cache';
import { closeDb, createDb, type Db } from '@hamnivo/db';
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { PersonalCacheScope } from '../cache/store.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, CONFIG, MAILER, PLATFORM_DB, REDIS } from '../tokens.js';
import { LogMailer, type Mailer, SmtpMailer } from './mailer.js';

export interface PlatformOverrides {
  mailer?: Mailer;
  clock?: () => Date;
  /** Replaces the transport of the Jev decision provider (tests). */
  decisionFetch?: typeof fetch;
  /** Replaces the cache store, for example with one that is down (tests). */
  cacheStore?: CacheStore;
  /**
   * Places entries private to one customer instead of customer memory (tests); `null` turns
   * per-customer caching off.
   */
  personalCacheScope?: PersonalCacheScope | null;
}

@Injectable()
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(PLATFORM_DB) private readonly platform: Db | null,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([
      closeDb(this.db),
      ...(this.platform ? [closeDb(this.platform)] : []),
      this.redis.quit(),
    ]);
  }
}

/** Process-wide infrastructure: configuration, database pool, Valkey, mail and clock. */
@Global()
@Module({})
export class PlatformModule {
  static forRoot(
    config: AppConfig,
    overrides: PlatformOverrides = {},
    role = 'gateway',
  ): DynamicModule {
    const mailer =
      overrides.mailer ??
      (config.SMTP_URL
        ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM)
        : new LogMailer((line) => process.stdout.write(`${line}\n`)));
    return {
      module: PlatformModule,
      global: true,
      providers: [
        { provide: CONFIG, useValue: config },
        {
          provide: APP_DB,
          useFactory: () =>
            createDb(config.DATABASE_URL, {
              max: config.DATABASE_POOL_MAX,
              applicationName: `hamnivo-${role}`,
              onConnectionError: (error) =>
                new Logger('Database').warn(
                  `connection lost${error.code ? ` (${error.code})` : ''}: ${error.message}`,
                ),
            }),
        },
        {
          // The platform console's own pool (hamnivo_platform: metadata only). Optional: without
          // DATABASE_PLATFORM_URL there is no platform console and no incident banners.
          provide: PLATFORM_DB,
          useFactory: () =>
            config.DATABASE_PLATFORM_URL
              ? createDb(config.DATABASE_PLATFORM_URL, {
                  max: 4,
                  applicationName: `hamnivo-${role}-platform`,
                })
              : null,
        },
        {
          provide: REDIS,
          // BullMQ requires maxRetriesPerRequest: null on shared connections.
          useFactory: () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
        },
        { provide: MAILER, useValue: mailer },
        { provide: CLOCK, useValue: overrides.clock ?? (() => new Date()) },
        ConnectionCloser,
      ],
      exports: [CONFIG, APP_DB, PLATFORM_DB, REDIS, MAILER, CLOCK],
    };
  }
}
