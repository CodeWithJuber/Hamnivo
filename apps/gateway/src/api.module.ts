import type { Db } from '@hamnivo/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { LanguageModel } from 'ai';
import { ACTIONS_API_CONTROLLERS, ACTIONS_API_PROVIDERS } from './actions/actions.module.js';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { BrandsController } from './admin/brands.controller.js';
import { BrandsService } from './admin/brands.service.js';
import { IdentityKeysController } from './admin/identity-keys.controller.js';
import { IdentityKeysService } from './admin/identity-keys.service.js';
import { AuditController } from './audit/audit.controller.js';
import { ConnectionsController } from './authority/connections.controller.js';
import { ConnectionsService } from './authority/connections.service.js';
import { ChatwootIngressController } from './authority/ingress.controller.js';
import { IngressService } from './authority/ingress.service.js';
import { JournalService } from './authority/journal.service.js';
import { OutboundMessagesService } from './authority/outbound.service.js';
import { OwnershipService } from './authority/ownership.service.js';
import { AuthorityRegistry } from './authority/registry.js';
import { StaffLinksService } from './authority/staff-links.service.js';
import { CacheController } from './cache/cache.controller.js';
import { cacheAdminProviders, cacheProviders } from './cache/cache.providers.js';
import { COMMERCE_API_CONTROLLERS, COMMERCE_API_PROVIDERS } from './commerce/commerce.module.js';
import { IdempotencyService } from './common/idempotency.service.js';
import type { AppConfig } from './config.js';
import { StaffConversationsController } from './conversations/staff-conversations.controller.js';
import { StaffConversationsService } from './conversations/staff-conversations.service.js';
import { DecisionsController } from './decisions/decisions.controller.js';
import { decisionAdminProviders, decisionProviders } from './decisions/decisions.providers.js';
import { createAuth } from './identity/auth.factory.js';
import { IdentityController } from './identity/identity.controller.js';
import { PrincipalService } from './identity/principal.service.js';
import { StaffGuard } from './identity/staff.guard.js';
import { TenantsService } from './identity/tenants.service.js';
import { InboxAccess } from './inbox/access.js';
import { AnnotationsService } from './inbox/annotations.service.js';
import { AssignmentService } from './inbox/assignment.service.js';
import { AssistService } from './inbox/assist.service.js';
import { BulkService } from './inbox/bulk.service.js';
import { CollaborationService } from './inbox/collaboration.service.js';
import { DraftsService } from './inbox/drafts.service.js';
import { InboxController, TeamsController } from './inbox/inbox.controller.js';
import { InboxService } from './inbox/inbox.service.js';
import { InboxLiveService } from './inbox/live.service.js';
import { InboxMessagesService } from './inbox/messages.service.js';
import { InboxSignals } from './inbox/signals.service.js';
import { StatusService } from './inbox/status.service.js';
import { TeamsService } from './inbox/teams.service.js';
import { EmbeddingFactory } from './knowledge/embeddings.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';
import { RetrievalService } from './knowledge/retrieval.service.js';
import { LanguageController } from './language/language.controller.js';
import { AdminMemoryController } from './memory/admin-memory.controller.js';
import { AdminMemoryService } from './memory/admin-memory.service.js';
import { MemoryCache } from './memory/cache.js';
import { CustomerMemoryService } from './memory/customer-memory.service.js';
import { MemoryDeletionService } from './memory/deletion.service.js';
import { MemoryFingerprints } from './memory/fingerprints.js';
import { WidgetMemoryController } from './memory/widget-memory.controller.js';
import { MemoryWriter } from './memory/writer.service.js';
import { HealthController } from './platform/health.controller.js';
import type { Mailer } from './platform/mailer.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { AgentsController } from './runtime/agents.controller.js';
import { AgentsService } from './runtime/agents.service.js';
import { KillSwitchesController } from './runtime/kill-switches.controller.js';
import { KillSwitchesService } from './runtime/kill-switches.service.js';
import { ModelConnectionsController } from './runtime/model-connections.controller.js';
import { ModelConnectionsService } from './runtime/model-connections.service.js';
import { LANGUAGE_MODEL, ModelFactory } from './runtime/models.js';
import { RunsController } from './runtime/runs.controller.js';
import { RunsService } from './runtime/runs.service.js';
import { SecretBroker } from './secrets/secret-broker.service.js';
import { SecretsController } from './secrets/secrets.controller.js';
import { APP_DB, AUTH, CONFIG, MAILER } from './tokens.js';
import { AuthorityContactsService } from './widget/contacts.service.js';
import { WidgetConversationsService } from './widget/conversations.service.js';
import { WidgetEventsService } from './widget/events.service.js';
import { WidgetSessionsService } from './widget/sessions.service.js';
import { WidgetTokens } from './widget/tokens.service.js';
import { WidgetController } from './widget/widget.controller.js';
import { WidgetGuard } from './widget/widget.guard.js';

export interface ApiOverrides extends PlatformOverrides {
  /** Replaces every agent's model (tests); agents otherwise use their configured model. */
  model?: LanguageModel;
}

/** HTTP API process: REST, staff authentication and administration. */
@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, overrides: ApiOverrides = {}): DynamicModule {
    return {
      module: ApiModule,
      imports: [PlatformModule.forRoot(config, overrides, 'gateway')],
      controllers: [
        HealthController,
        IdentityController,
        AdminController,
        SecretsController,
        AuditController,
        BrandsController,
        IdentityKeysController,
        ConnectionsController,
        ChatwootIngressController,
        WidgetController,
        StaffConversationsController,
        AgentsController,
        ModelConnectionsController,
        KillSwitchesController,
        RunsController,
        KnowledgeController,
        DecisionsController,
        CacheController,
        LanguageController,
        WidgetMemoryController,
        AdminMemoryController,
        InboxController,
        TeamsController,
        ...COMMERCE_API_CONTROLLERS,
        ...ACTIONS_API_CONTROLLERS,
      ],
      providers: [
        {
          provide: AUTH,
          inject: [CONFIG, APP_DB, MAILER],
          useFactory: (cfg: AppConfig, db: Db, mailer: Mailer) => createAuth(cfg, db, mailer),
        },
        PrincipalService,
        TenantsService,
        AdminService,
        IdempotencyService,
        SecretBroker,
        BrandsService,
        IdentityKeysService,
        ConnectionsService,
        AuthorityRegistry,
        IngressService,
        JournalService,
        OwnershipService,
        OutboundMessagesService,
        StaffLinksService,
        InboxAccess,
        InboxSignals,
        DraftsService,
        StaffConversationsService,
        InboxService,
        InboxMessagesService,
        AssignmentService,
        StatusService,
        AnnotationsService,
        AssistService,
        CollaborationService,
        BulkService,
        TeamsService,
        InboxLiveService,
        ...(overrides.model ? [{ provide: LANGUAGE_MODEL, useValue: overrides.model }] : []),
        ModelFactory,
        KillSwitchesService,
        AgentsService,
        ModelConnectionsService,
        RunsService,
        EmbeddingFactory,
        RetrievalService,
        KnowledgeService,
        WidgetTokens,
        WidgetSessionsService,
        AuthorityContactsService,
        WidgetConversationsService,
        WidgetEventsService,
        ...decisionProviders(overrides),
        ...decisionAdminProviders,
        ...cacheProviders(overrides),
        ...cacheAdminProviders,
        MemoryFingerprints,
        MemoryCache,
        MemoryWriter,
        MemoryDeletionService,
        CustomerMemoryService,
        AdminMemoryService,
        ...COMMERCE_API_PROVIDERS,
        ...ACTIONS_API_PROVIDERS,
        { provide: APP_GUARD, useClass: StaffGuard },
        { provide: APP_GUARD, useClass: WidgetGuard },
      ],
    };
  }
}
