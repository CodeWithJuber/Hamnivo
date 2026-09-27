import type { Db } from '@hamnivo/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
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
import { IdempotencyService } from './common/idempotency.service.js';
import type { AppConfig } from './config.js';
import { StaffConversationsController } from './conversations/staff-conversations.controller.js';
import { StaffConversationsService } from './conversations/staff-conversations.service.js';
import { createAuth } from './identity/auth.factory.js';
import { IdentityController } from './identity/identity.controller.js';
import { PrincipalService } from './identity/principal.service.js';
import { StaffGuard } from './identity/staff.guard.js';
import { TenantsService } from './identity/tenants.service.js';
import { EmbeddingFactory } from './knowledge/embeddings.js';
import { KnowledgeController } from './knowledge/knowledge.controller.js';
import { KnowledgeService } from './knowledge/knowledge.service.js';
import { RetrievalService } from './knowledge/retrieval.service.js';
import { MigrationController } from './migration/migration.controller.js';
import { MigrationService } from './migration/migration.service.js';
import { HealthController } from './platform/health.controller.js';
import type { Mailer } from './platform/mailer.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { AgentsController } from './runtime/agents.controller.js';
import { AgentsService } from './runtime/agents.service.js';
import { KillSwitchesController } from './runtime/kill-switches.controller.js';
import { KillSwitchesService } from './runtime/kill-switches.service.js';
import { ModelConnectionsController } from './runtime/model-connections.controller.js';
import { ModelConnectionsService } from './runtime/model-connections.service.js';
import { ModelFactory } from './runtime/models.js';
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

/** HTTP API process: REST, staff authentication and administration. */
@Module({})
export class ApiModule {
  static forRoot(config: AppConfig, overrides: PlatformOverrides = {}): DynamicModule {
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
        MigrationController,
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
        StaffConversationsService,
        ModelFactory,
        KillSwitchesService,
        AgentsService,
        ModelConnectionsService,
        RunsService,
        EmbeddingFactory,
        RetrievalService,
        KnowledgeService,
        MigrationService,
        WidgetTokens,
        WidgetSessionsService,
        AuthorityContactsService,
        WidgetConversationsService,
        WidgetEventsService,
        { provide: APP_GUARD, useClass: StaffGuard },
        { provide: APP_GUARD, useClass: WidgetGuard },
      ],
    };
  }
}
