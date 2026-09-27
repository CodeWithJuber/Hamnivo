import { closeDb, createDb, type Db } from '@hamnivo/db';
import {
  type DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, CONFIG, MAILER, REDIS } from '../tokens.js';
import { LogMailer, type Mailer, SmtpMailer } from './mailer.js';

export interface PlatformOverrides {
  mailer?: Mailer;
  clock?: () => Date;
}

@Injectable()
class ConnectionCloser implements OnApplicationShutdown {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([closeDb(this.db), this.redis.quit()]);
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
            }),
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
      exports: [CONFIG, APP_DB, REDIS, MAILER, CLOCK],
    };
  }
}
