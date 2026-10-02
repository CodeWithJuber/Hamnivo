import type { Resolver } from '@hamnivo/adapters/net';
import type { Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AnalyticsController } from '../analytics/analytics.controller.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { BillingController } from '../billing/billing.controller.js';
import { BillingService } from '../billing/billing.service.js';
import { EntitlementsService } from '../billing/entitlements.service.js';
import { ActorGuard } from './actor.js';
import { ApiKeysController, CurrentApiKeyController } from './api-keys.controller.js';
import { ApiKeysService } from './api-keys.service.js';
import { EgressController } from './egress.controller.js';
import { EGRESS_RESOLVER, EgressService } from './egress.service.js';
import { ApiKeyRateLimiter } from './rate-limit.js';
import { WebhookDeliveriesService } from './webhooks/deliveries.service.js';
import { WebhookDispatcher } from './webhooks/dispatcher.service.js';
import { WebhookEndpointsService } from './webhooks/endpoints.service.js';
import { WebhookFanout } from './webhooks/fanout.service.js';
import { WebhookSender } from './webhooks/sender.service.js';
import { WebhooksController } from './webhooks.controller.js';

/**
 * Developer platform and billing wiring (boards 19 and 23): API keys, webhooks, the egress
 * allowlist, plan limits, billing and analytics. Both processes rely on the platform module and
 * the secret broker their modules already provide.
 */
export interface DeveloperOverrides {
  /** Replaces DNS resolution for outbound requests (tests of the SSRF guard). */
  egressResolver?: Resolver;
}

function shared(overrides: DeveloperOverrides): Provider[] {
  return [
    ...(overrides.egressResolver
      ? [{ provide: EGRESS_RESOLVER, useValue: overrides.egressResolver }]
      : []),
    EgressService,
    EntitlementsService,
    WebhookSender,
    WebhookFanout,
  ];
}

export const DEVELOPER_API_CONTROLLERS = [
  ApiKeysController,
  CurrentApiKeyController,
  WebhooksController,
  EgressController,
  BillingController,
  AnalyticsController,
];

export function developerApiProviders(overrides: DeveloperOverrides = {}): Provider[] {
  return [
    ...shared(overrides),
    ApiKeysService,
    ApiKeyRateLimiter,
    WebhookEndpointsService,
    WebhookDeliveriesService,
    BillingService,
    AnalyticsService,
    { provide: APP_GUARD, useClass: ActorGuard },
  ];
}

export function developerWorkerProviders(overrides: DeveloperOverrides = {}): Provider[] {
  return [...shared(overrides), WebhookDispatcher];
}
