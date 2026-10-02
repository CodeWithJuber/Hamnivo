import type * as C from '@hamnivo/contracts';
import type { z } from 'zod';
import { api } from './api';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

/** API shapes of the developer platform (board 19), at type level only. */
export type ApiKey = C.ApiKey;
export type CreatedApiKey = C.CreatedApiKey;
export type ApiKeyPermission = C.ApiKeyPermission;
export type ApiKeyPermissionOption = z.infer<typeof C.ApiKeyPermissionOption>;
export type WebhookEndpoint = C.WebhookEndpoint;
export type CreatedWebhookEndpoint = C.CreatedWebhookEndpoint;
export type RotatedWebhookSecret = C.RotatedWebhookSecret;
export type WebhookDelivery = C.WebhookDelivery;
export type WebhookDeliveryDetail = C.WebhookDeliveryDetail;
export type WebhookAttempt = z.infer<typeof C.WebhookAttempt>;
export type WebhookEventType = z.infer<typeof C.WebhookEventType>;
export type WebhookEventSummary = z.infer<typeof C.WebhookEventSummary>;
export type WebhookEventTypeInfo = z.infer<typeof C.WebhookEventTypeInfo>;
export type TestWebhookResult = C.TestWebhookResult;
export type EgressPolicy = C.EgressPolicy;
export type Page<T> = { items: T[]; nextCursor: string | null };
export type WebhookEventCategory = C.WebhookEventCategory;

const CATEGORIES: readonly WebhookEventCategory[] = [
  'conversations',
  'messages',
  'handoffs',
  'orders',
  'payments',
  'refunds',
  'memory',
  'usage',
  'testing',
];

/** A category the server sent that Studio has a name for. */
export const isEventCategory = (value: string): value is WebhookEventCategory =>
  (CATEGORIES as readonly string[]).includes(value);

type Snake<T extends string> = T extends `${infer Head}.${infer Tail}`
  ? `${Head}_${Snake<Tail>}`
  : T;
export type WebhookEventKey = Snake<WebhookEventType>;

/** `order.updated` → `order_updated`, the translation key of the event's description. */
export const eventKey = (type: WebhookEventType) => type.replaceAll('.', '_') as WebhookEventKey;

export const developerKeys = {
  apiKeys: ['developer', 'api-keys'],
  permissions: ['developer', 'api-keys', 'permissions'],
  endpoints: ['developer', 'webhooks', 'endpoints'],
  deliveries: (endpointId: string) => ['developer', 'webhooks', 'deliveries', endpointId],
  delivery: (id: string) => ['developer', 'webhooks', 'delivery', id],
  events: (type: string) => ['developer', 'webhooks', 'events', type],
  eventTypes: ['developer', 'webhooks', 'event-types'],
  egress: ['developer', 'network', 'egress'],
} as const;

/** Everything a change to webhooks can affect. */
export const WEBHOOK_KEYS = [['developer', 'webhooks'], developerKeys.egress] as const;

export function useApiKeys() {
  const { can } = useTenant();
  return useStudioQuery<Items<ApiKey>>(developerKeys.apiKeys, '/v1/admin/api-keys', {
    enabled: can('api_keys.read'),
  });
}

export function useApiKeyPermissions() {
  const { can } = useTenant();
  return useStudioQuery<Items<ApiKeyPermissionOption>>(
    developerKeys.permissions,
    '/v1/admin/api-keys/permissions',
    { enabled: can('api_keys.read') },
  );
}

export function useEndpoints() {
  const { can } = useTenant();
  return useStudioQuery<Items<WebhookEndpoint>>(
    developerKeys.endpoints,
    '/v1/admin/webhooks/endpoints',
    { enabled: can('webhooks.read') },
  );
}

export function useEventTypes() {
  const { can } = useTenant();
  return useStudioQuery<Items<WebhookEventTypeInfo>>(
    developerKeys.eventTypes,
    '/v1/admin/webhooks/event-types',
    { enabled: can('webhooks.read') },
  );
}

export function useDeliveries(endpointId: string | null) {
  const { can } = useTenant();
  return useStudioQuery<Page<WebhookDelivery>>(
    developerKeys.deliveries(endpointId ?? ''),
    `/v1/admin/webhooks/deliveries?endpointId=${encodeURIComponent(endpointId ?? '')}&limit=20`,
    {
      enabled: can('webhooks.read') && endpointId !== null,
      // Pending retries move on by themselves.
      refetchInterval: (data) =>
        data?.items.some((delivery) => delivery.status === 'pending') ? 5000 : false,
    },
  );
}

export function useDelivery(id: string | null) {
  const { can } = useTenant();
  return useStudioQuery<WebhookDeliveryDetail>(
    developerKeys.delivery(id ?? ''),
    `/v1/admin/webhooks/deliveries/${encodeURIComponent(id ?? '')}`,
    { enabled: can('webhooks.read') && id !== null },
  );
}

export function useEgressPolicy() {
  const { can } = useTenant();
  return useStudioQuery<EgressPolicy>(developerKeys.egress, '/v1/admin/network/egress', {
    enabled: can('webhooks.read') || can('network.manage'),
  });
}

/** A change through the developer API; every webhook view reloads afterwards. */
export function useWebhookChange<TVars, TResult>(
  run: (vars: TVars, tenantId: string) => Promise<TResult>,
) {
  return useStudioMutation(run, WEBHOOK_KEYS);
}

export const endpointPath = (id: string) =>
  `/v1/admin/webhooks/endpoints/${encodeURIComponent(id)}`;

export function sendTest(id: string, tenant: string) {
  return api<TestWebhookResult>(`${endpointPath(id)}/test`, { method: 'POST', tenant });
}
