import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { AppConfig } from './config.js';
import { OUTBOX_HANDLERS, type OutboxHandler, OutboxRelay } from './outbox/relay.service.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { MaintenanceService } from './worker/maintenance.service.js';

/** Outbox topics with a consumer; later modules register theirs here (e.g. Chatwoot provisioning). */
export function defaultOutboxHandlers(): Map<string, OutboxHandler> {
  const logger = new Logger('outbox');
  return new Map<string, OutboxHandler>([
    ['tenant.created', async (event) => logger.log(`tenant created: ${event.aggregateId}`)],
  ]);
}

/** Background process: outbox relay and scheduled maintenance. */
@Module({})
export class WorkerModule {
  static forRoot(
    config: AppConfig,
    overrides: PlatformOverrides & { handlers?: Map<string, OutboxHandler> } = {},
  ): DynamicModule {
    return {
      module: WorkerModule,
      imports: [PlatformModule.forRoot(config, overrides, 'worker')],
      providers: [
        { provide: OUTBOX_HANDLERS, useValue: overrides.handlers ?? defaultOutboxHandlers() },
        OutboxRelay,
        MaintenanceService,
      ],
      exports: [OutboxRelay, MaintenanceService],
    };
  }
}
