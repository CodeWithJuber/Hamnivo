import type { ClaimedOutboxEvent } from '@hamnivo/db';
import type { Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ProvisioningController } from '../authority/provisioning.controller.js';
import { ChatwootProvisioning, PROVISION_TOPIC } from '../authority/provisioning.service.js';
import { BillingWebhooksController } from '../billing/billing.controller.js';
import { BillingLifecycleService } from '../billing/lifecycle.service.js';
import { BILLING_NOTICE_TOPIC, BillingNotices } from '../billing/notices.js';
import { billingProvider } from '../billing/provider.js';
import { SubscriptionsService } from '../billing/subscriptions.service.js';
import { SignupController } from '../identity/tenants.controller.js';
import { OperatorApiController } from './operator.controller.js';
import { OperatorKeyGuard, OperatorKeysService } from './operator-keys.js';
import { SaasConsoleController } from './saas-console.controller.js';
import { SignupPolicy } from './signup.js';
import { TenantLifecycleService } from './tenant-lifecycle.js';
import { WorkspaceEmailController, WorkspaceEmailService } from './workspace-email.js';

/**
 * Running one install as a SaaS: sign-up controls, subscriptions through the billing provider,
 * the operator API for billing systems, tenant lifecycle from the platform console, automatic
 * Chatwoot set-up and workspace email settings. The API and worker modules spread these in.
 */
export const SAAS_API_CONTROLLERS = [
  SignupController,
  SaasConsoleController,
  OperatorApiController,
  BillingWebhooksController,
  WorkspaceEmailController,
  ProvisioningController,
];

export const SAAS_API_PROVIDERS: Provider[] = [
  billingProvider,
  SubscriptionsService,
  SignupPolicy,
  OperatorKeysService,
  TenantLifecycleService,
  WorkspaceEmailService,
  ChatwootProvisioning,
  { provide: APP_GUARD, useClass: OperatorKeyGuard },
];

export const SAAS_WORKER_PROVIDERS: Provider[] = [
  ChatwootProvisioning,
  BillingNotices,
  BillingLifecycleService,
];

/** Outbox consumers of the SaaS features (worker). */
export function saasOutboxHandlers(
  provisioning: ChatwootProvisioning,
  notices: BillingNotices,
): [string, (event: ClaimedOutboxEvent) => Promise<void>][] {
  return [
    ['tenant.created', (event) => provisioning.onTenantCreated(event)],
    [PROVISION_TOPIC, (event) => provisioning.onProvision(event)],
    [BILLING_NOTICE_TOPIC, (event) => notices.onNotice(event)],
  ];
}
