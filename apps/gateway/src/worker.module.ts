import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { JournalService } from './authority/journal.service.js';
import { OwnershipService } from './authority/ownership.service.js';
import { InboxProcessor } from './authority/processor.service.js';
import { AuthorityRegistry } from './authority/registry.js';
import { StaffLinksService } from './authority/staff-links.service.js';
import { AuthoritySyncService } from './authority/sync.service.js';
import type { AppConfig } from './config.js';
import { OUTBOX_HANDLERS, type OutboxHandler, OutboxRelay } from './outbox/relay.service.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { AgentsService } from './runtime/agents.service.js';
import { KillSwitchesService } from './runtime/kill-switches.service.js';
import { LANGUAGE_MODEL, ModelFactory } from './runtime/models.js';
import { RepliesService } from './runtime/replies.service.js';
import { RunsService } from './runtime/runs.service.js';
import { SecretBroker } from './secrets/secret-broker.service.js';
import { AuthorityContactsService } from './widget/contacts.service.js';
import { MaintenanceService } from './worker/maintenance.service.js';

/** Outbox topics with a consumer that needs no other service. */
export function defaultOutboxHandlers(): Map<string, OutboxHandler> {
  const logger = new Logger('outbox');
  return new Map<string, OutboxHandler>([
    ['tenant.created', async (event) => logger.log(`tenant created: ${event.aggregateId}`)],
    [
      'authority.connected',
      async (event) => logger.log(`authority connected: ${event.aggregateId}`),
    ],
  ]);
}

export interface WorkerOverrides extends PlatformOverrides {
  /** Replaces every outbox handler (tests of the relay itself). */
  handlers?: Map<string, OutboxHandler>;
  /** Replaces every agent's model (tests); agents otherwise use their configured model. */
  model?: LanguageModel;
}

/**
 * Background process: outbox relay (owner sync to Chatwoot, AI replies), the integration-inbox
 * processor for Chatwoot webhooks, and scheduled maintenance.
 */
@Module({})
export class WorkerModule {
  static forRoot(config: AppConfig, overrides: WorkerOverrides = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [PlatformModule.forRoot(config, overrides, 'worker')],
      providers: [
        SecretBroker,
        AuthorityRegistry,
        JournalService,
        OwnershipService,
        StaffLinksService,
        AuthoritySyncService,
        InboxProcessor,
        ...(overrides.model ? [{ provide: LANGUAGE_MODEL, useValue: overrides.model }] : []),
        ModelFactory,
        KillSwitchesService,
        AgentsService,
        RunsService,
        AuthorityContactsService,
        RepliesService,
        {
          provide: OUTBOX_HANDLERS,
          inject: [AuthoritySyncService, RepliesService],
          useFactory: (sync: AuthoritySyncService, replies: RepliesService) =>
            overrides.handlers ??
            new Map<string, OutboxHandler>([
              ...defaultOutboxHandlers(),
              ['conversation.owner_changed', (event) => sync.applyOwnerChange(event)],
              ['conversation.customer_message', (event) => replies.onCustomerMessage(event)],
            ]),
        },
        OutboxRelay,
        MaintenanceService,
      ],
      exports: [OutboxRelay, MaintenanceService, InboxProcessor, RepliesService, JournalService],
    };
  }
}
