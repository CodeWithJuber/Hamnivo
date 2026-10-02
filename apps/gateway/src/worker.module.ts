import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { ACTIONS_WORKER_PROVIDERS } from './actions/actions.module.js';
import { ACTION_EXECUTE_TOPIC, ActionExecutor } from './actions/executor.service.js';
import { ACTION_RECONCILE_TOPIC } from './actions/inbox-actions.service.js';
import { ActionsWorker } from './actions/worker.service.js';
import { JournalService } from './authority/journal.service.js';
import { OwnershipService } from './authority/ownership.service.js';
import { InboxProcessor } from './authority/processor.service.js';
import { PublicationsService } from './authority/publications.service.js';
import { ReconcilerService } from './authority/reconciler.service.js';
import { AuthorityRegistry } from './authority/registry.js';
import { StaffLinksService } from './authority/staff-links.service.js';
import { AuthoritySyncService } from './authority/sync.service.js';
import { cacheProviders } from './cache/cache.providers.js';
import { CARD_TOPIC, CommerceCardsService } from './commerce/card-publisher.service.js';
import { COMMERCE_WORKER_PROVIDERS } from './commerce/commerce.module.js';
import { CommerceWorker } from './commerce/worker.service.js';
import type { AppConfig } from './config.js';
import { decisionProviders } from './decisions/decisions.providers.js';
import { RoutingService } from './decisions/routing.service.js';
import { EmbeddingFactory } from './knowledge/embeddings.js';
import { IngestionService, SCANNER } from './knowledge/ingestion.service.js';
import { RetrievalService } from './knowledge/retrieval.service.js';
import { type Scanner, scannerFromUrl } from './knowledge/scanner.js';
import { MemoryCache } from './memory/cache.js';
import { ConversationHistory } from './memory/conversation-history.js';
import { MemoryDeletionService } from './memory/deletion.service.js';
import { MemoryExtractionService } from './memory/extraction.service.js';
import { MemoryFingerprints } from './memory/fingerprints.js';
import { MemoryIndexService } from './memory/index.service.js';
import { MemoryRecallService } from './memory/recall.service.js';
import { MemoryWriter } from './memory/writer.service.js';
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
  /** Replaces the upload scanner (tests); ClamAV or the EICAR check otherwise. */
  scanner?: Scanner;
}

/**
 * Background process: outbox relay (owner sync to Chatwoot, AI replies, commerce cards), the
 * commerce worker (provider events and reconciliation), the integration-inbox
 * processor for Chatwoot webhooks, the reconciler that catches what webhooks missed, and
 * scheduled maintenance.
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
        PublicationsService,
        InboxProcessor,
        ReconcilerService,
        ...(overrides.model ? [{ provide: LANGUAGE_MODEL, useValue: overrides.model }] : []),
        ModelFactory,
        KillSwitchesService,
        AgentsService,
        RunsService,
        AuthorityContactsService,
        ...decisionProviders(overrides),
        ...cacheProviders(overrides),
        EmbeddingFactory,
        RetrievalService,
        { provide: SCANNER, useValue: overrides.scanner ?? scannerFromUrl(config.CLAMAV_URL) },
        IngestionService,
        MemoryFingerprints,
        MemoryCache,
        MemoryWriter,
        MemoryDeletionService,
        MemoryRecallService,
        MemoryIndexService,
        ConversationHistory,
        MemoryExtractionService,
        RepliesService,
        ...COMMERCE_WORKER_PROVIDERS,
        ...ACTIONS_WORKER_PROVIDERS,
        {
          provide: OUTBOX_HANDLERS,
          inject: [
            AuthoritySyncService,
            RepliesService,
            IngestionService,
            MemoryExtractionService,
            MemoryIndexService,
            MemoryDeletionService,
            RoutingService,
            CommerceCardsService,
            ActionExecutor,
            ActionsWorker,
          ],
          useFactory: (
            sync: AuthoritySyncService,
            replies: RepliesService,
            ingestion: IngestionService,
            extraction: MemoryExtractionService,
            index: MemoryIndexService,
            deletions: MemoryDeletionService,
            routing: RoutingService,
            cards: CommerceCardsService,
            executor: ActionExecutor,
            actions: ActionsWorker,
          ) =>
            overrides.handlers ??
            new Map<string, OutboxHandler>([
              ...defaultOutboxHandlers(),
              ['conversation.owner_changed', (event) => sync.applyOwnerChange(event)],
              ['conversation.team_changed', (event) => sync.applyTeamChange(event)],
              ['conversation.note', (event) => sync.applyNote(event)],
              [
                'conversation.customer_message',
                // The reply comes first; memory extraction is queued after it, never before.
                async (event) => {
                  await replies.onCustomerMessage(event);
                  await extraction.afterCustomerMessage(event);
                },
              ],
              ['knowledge.ingest', (event) => ingestion.onIngest(event)],
              ['memory.extract', async (event) => void (await extraction.onExtract(event))],
              ['memory.embed', (event) => index.onEmbed(event)],
              ['memory.deleted', (event) => deletions.complete(event)],
              ['conversation.route', (event) => routing.onRoute(event)],
              [CARD_TOPIC, (event) => cards.onCardEvent(event)],
              [ACTION_EXECUTE_TOPIC, (event) => executor.onExecute(event)],
              [ACTION_RECONCILE_TOPIC, (event) => actions.onReconcile(event)],
            ]),
        },
        OutboxRelay,
        MaintenanceService,
      ],
      exports: [
        OutboxRelay,
        MaintenanceService,
        InboxProcessor,
        ReconcilerService,
        RepliesService,
        JournalService,
        MemoryExtractionService,
        MemoryDeletionService,
        CommerceWorker,
        ActionsWorker,
        ActionExecutor,
      ],
    };
  }
}
