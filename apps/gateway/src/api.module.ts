import type { Db } from '@hamnivo/db';
import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { AuditController } from './audit/audit.controller.js';
import { IdempotencyService } from './common/idempotency.service.js';
import type { AppConfig } from './config.js';
import { createAuth } from './identity/auth.factory.js';
import { IdentityController } from './identity/identity.controller.js';
import { PrincipalService } from './identity/principal.service.js';
import { StaffGuard } from './identity/staff.guard.js';
import { TenantsService } from './identity/tenants.service.js';
import { HealthController } from './platform/health.controller.js';
import type { Mailer } from './platform/mailer.js';
import { PlatformModule, type PlatformOverrides } from './platform/platform.module.js';
import { SecretBroker } from './secrets/secret-broker.service.js';
import { SecretsController } from './secrets/secrets.controller.js';
import { APP_DB, AUTH, CONFIG, MAILER } from './tokens.js';

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
        { provide: APP_GUARD, useClass: StaffGuard },
      ],
    };
  }
}
