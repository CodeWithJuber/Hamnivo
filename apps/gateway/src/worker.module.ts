import { type DynamicModule, Logger, Module } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { ACTIONS_WORKER_PROVIDERS } from './actions/actions.module.js';
import { ACTION_EXECUTE_TOPIC, ActionExecutor } from './actions/executor.service.js';
import { ACTION_RECONCILE_TOPIC } from './actions/inbox-actions.service.js';
import { ActionsWorker } from './actions/worker.service.js';
import { ChannelAdoption } from './authority/adopt.js';
import { CHANNEL_HEALTH_TOPIC, ChannelHealthNotices } from './authority/channel-health.js';
import { ChannelInboxesService } from './authority/channel-inboxes.service.js';
import { ChannelPollService } from './authority/channel-poll.service.js';
import { JournalService } from './authority/journal.service.js';
import { OwnershipService } from './authority/ownership.service.js';
import { InboxProcessor } from './authority/processor.service.js';
import { ChatwootProvisioning } from './authority/provisioning.service.js';
import { PublicationsService } from './authority/publications.service.js';
import { ReconcilerService } from './authority/reconciler.service.js';
import { AuthorityRegistry } from './authority/registry.js';
import { StaffLinksService } from './authority/staff-links.service.js';
import { AuthoritySyncService } from './authority/sync.service.js';
import { AUTOMATION_TOPIC } from './automations/events.js';
import { AutomationRunner } from './automations/runner.service.js';
import { BillingNotices } from './billing/notices.js';
import { cacheProviders } from './cache/cache.providers.js';
import { CARD_TOPIC, CommerceCardsService } from './commerce/card-publisher.service.js';
import { COMMERCE_WORKER_PROVIDERS } from './commerce/commerce.module.js';
import { CommerceWorker } from './commerce/worker.service.js';
import type { AppConfig } from './config.js';
import { decisionProviders } from './decisions/decisions.providers.js';
import { RoutingService } from './decisions/routing.service.js';
import { type DeveloperOverrides, developerWorkerProviders } from './developer/developer.module.js';
import { WebhookDispatcher } from './developer/webhooks/dispatcher.service.js';
import { WEBHOOK_SOURCE_TOPIC, WebhookFanout } from './developer/webhooks/fanout.service.js';
import { InboxAccess } from './inbox/access.js';
import { AvailabilityService } from './inbox/availability.service.js';
import { OFFER_NEXT_TOPIC, OFFER_TIMEOUT_TOPIC } from './inbox/offers.js';
import { OffersService } from './inbox/offers.service.js';
import { SLA_DUE_TOPIC, SLA_RESYNC_TOPIC } from './inbox/sla.js';
import { SlaService } from './inbox/sla.service.js';
import { EmbeddingFactory } from './knowledge/embeddings.js';
import { IngestionService, SCANNER } from './knowledge/ingestion.service.js';
import { RetrievalService } from './knowledge/retrieval.service.js';
import { type Scanner, scannerFromUrl } from './knowledge/scanner.js';
import { KNOWLEDGE_WEB_WORKER_PROVIDERS } from './knowledge/web/web.module.js';
import { MemoryCache } from './memory/cache.js';
import { ConversationHistory } from './memory/conversation-history.js';
import { MemoryDeletionService } from './memory/deletion.service.js';
import { MemoryExtractionService } from './memory/extraction.service.js';
import { MemoryFingerprints } from './memory/fingerprints.js';
import { MemoryIndexService } from './memory/index.service.js';
import { MemoryRecallService } from './memory/recall.service.js';
import { MemoryWriter } from './memory/writer.service.js';
import { MigrationEngine } from './migration/engine.service.js';
import { MigrationExporter } from './migration/export.service.js';
import { OUTBOX_HANDLERS, type OutboxHandler, OutboxRelay } from './outbox/relay.service.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { SAAS_WORKER_PROVIDERS, saasOutboxHandlers } from './platform/saas.module.js';
import { AgentsService } from './runtime/agents.service.js';
import { KillSwitchesService } from './runtime/kill-switches.service.js';
import { LANGUAGE_MODEL, ModelFactory } from './runtime/models.js';
import {
  RepliesService,
  SAFE_REPLY_FALLBACK_TOPIC,
  SAFE_REPLY_TOPIC,
} from './runtime/replies.service.js';
import { RunsService } from './runtime/runs.service.js';
import { SecretBroker } from './secrets/secret-broker.service.js';
import { AuthorityContactsService } from './widget/contacts.service.js';
import { CustomerEmailsService } from './widget/customer-emails.service.js';
import { REPLY_WAITING_TOPIC, TRANSCRIPT_TOPIC } from './widget/notify-queue.js';
import { TICKET_CONFIRM_TOPIC } from './widget/offline-messages.service.js';
import { WIDGET_SURFACE_WORKER_PROVIDERS } from './widget/surface.module.js';
import { TicketEmailsService } from './widget/ticket-emails.service.js';
import { MaintenanceService } from './worker/maintenance.service.js';

/** Outbox topics with a consumer that needs no other service. */
export function defaultOutboxHandlers(): Map<string, OutboxHandler> {
  const logger = new Logger('outbox');
  return new Map<string, OutboxHandler>([
    [
      'authority.connected',
      async (event) => logger.log(`authority connected: ${event.aggregateId}`),
    ],
  ]);
}

export interface WorkerOverrides extends PlatformOverrides, DeveloperOverrides {
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
        ChannelAdoption,
        ChannelHealthNotices,
        SlaService,
        OffersService,
        InboxProcessor,
        ReconcilerService,
        ChannelInboxesService,
        ChannelPollService,
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
        ...developerWorkerProviders(overrides),
        RepliesService,
        InboxAccess,
        AvailabilityService,
        AutomationRunner,
        MigrationEngine,
        MigrationExporter,
        ...COMMERCE_WORKER_PROVIDERS,
        ...WIDGET_SURFACE_WORKER_PROVIDERS,
        ...ACTIONS_WORKER_PROVIDERS,
        ...SAAS_WORKER_PROVIDERS,
        ...KNOWLEDGE_WEB_WORKER_PROVIDERS,
        {
          provide: OUTBOX_HANDLERS,
          inject: [
            AuthoritySyncService,
            RepliesService,
            IngestionService,
            MigrationEngine,
            MigrationExporter,
            MemoryExtractionService,
            MemoryIndexService,
            MemoryDeletionService,
            RoutingService,
            CommerceCardsService,
            WebhookFanout,
            CustomerEmailsService,
            TicketEmailsService,
            ActionExecutor,
            ActionsWorker,
            ChatwootProvisioning,
            BillingNotices,
            AutomationRunner,
            ChannelHealthNotices,
            SlaService,
            OffersService,
          ],
          useFactory: (
            sync: AuthoritySyncService,
            replies: RepliesService,
            ingestion: IngestionService,
            migration: MigrationEngine,
            exporter: MigrationExporter,
            extraction: MemoryExtractionService,
            index: MemoryIndexService,
            deletions: MemoryDeletionService,
            routing: RoutingService,
            cards: CommerceCardsService,
            webhooks: WebhookFanout,
            emails: CustomerEmailsService,
            ticketEmails: TicketEmailsService,
            executor: ActionExecutor,
            actions: ActionsWorker,
            provisioning: ChatwootProvisioning,
            notices: BillingNotices,
            automations: AutomationRunner,
            channelHealth: ChannelHealthNotices,
            sla: SlaService,
            offers: OffersService,
          ) =>
            overrides.handlers ??
            new Map<string, OutboxHandler>([
              ...defaultOutboxHandlers(),
              ['conversation.owner_changed', (event) => sync.applyOwnerChange(event)],
              [
                'conversation.team_changed',
                // A conversation that waits in a team which offers conversations is offered to
                // one of its people (HNV-10-03), whatever the Chatwoot sync did.
                async (event) => {
                  try {
                    await sync.applyTeamChange(event);
                  } finally {
                    await offers.afterRoute(event);
                  }
                },
              ],
              ['conversation.note', (event) => sync.applyNote(event)],
              ['conversation.close_blocked', (event) => sync.applyBlockedClose(event)],
              [
                'conversation.customer_message',
                // The reply comes first; memory extraction is queued after it, never before.
                async (event) => {
                  await replies.onCustomerMessage(event);
                  await extraction.afterCustomerMessage(event);
                },
              ],
              [SAFE_REPLY_TOPIC, (event) => replies.onSafeReply(event)],
              [SAFE_REPLY_FALLBACK_TOPIC, (event) => replies.onSafeReplyFallback(event)],
              ['knowledge.ingest', (event) => ingestion.onIngest(event)],
              ['migration.scan', (event) => migration.onScan(event)],
              ['migration.dry_run', (event) => migration.onDryRun(event)],
              ['migration.run', (event) => migration.onRun(event)],
              ['migration.rollback', (event) => migration.onRollback(event)],
              ['migration.export', (event) => exporter.onExport(event)],
              ['memory.extract', async (event) => void (await extraction.onExtract(event))],
              ['memory.embed', (event) => index.onEmbed(event)],
              ['memory.deleted', (event) => deletions.complete(event)],
              [
                'conversation.route',
                // Routing picks the team; then the team's offers start (HNV-10-03), whether or not
                // routing changed anything.
                async (event) => {
                  try {
                    await routing.onRoute(event);
                  } finally {
                    await offers.afterRoute(event);
                  }
                },
              ],
              [OFFER_TIMEOUT_TOPIC, (event) => offers.onTimeout(event)],
              [OFFER_NEXT_TOPIC, (event) => offers.onNext(event)],
              [CARD_TOPIC, (event) => cards.onCardEvent(event)],
              [WEBHOOK_SOURCE_TOPIC, (event) => webhooks.onSource(event)],
              [TRANSCRIPT_TOPIC, (event) => emails.onTranscript(event)],
              [REPLY_WAITING_TOPIC, (event) => emails.onReplyWaiting(event)],
              [TICKET_CONFIRM_TOPIC, (event) => ticketEmails.onConfirm(event)],
              [ACTION_EXECUTE_TOPIC, (event) => executor.onExecute(event)],
              [ACTION_RECONCILE_TOPIC, (event) => actions.onReconcile(event)],
              [AUTOMATION_TOPIC, (event) => automations.onEvent(event)],
              [CHANNEL_HEALTH_TOPIC, (event) => channelHealth.onEvent(event)],
              [SLA_DUE_TOPIC, (event) => sla.onDue(event)],
              [SLA_RESYNC_TOPIC, (event) => sla.onResync(event)],
              ...saasOutboxHandlers(provisioning, notices),
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
        ChannelPollService,
        RepliesService,
        JournalService,
        MemoryExtractionService,
        MemoryDeletionService,
        CommerceWorker,
        WebhookDispatcher,
        ActionsWorker,
        ActionExecutor,
      ],
    };
  }
}
