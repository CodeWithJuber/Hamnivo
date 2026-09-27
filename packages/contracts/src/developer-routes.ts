import { z } from 'zod';
import {
  ApiKey,
  ApiKeyIdentity,
  ApiKeyPermissionOption,
  CreateApiKeyRequest,
  CreatedApiKey,
  CreatedWebhookEndpoint,
  CreateWebhookEndpointRequest,
  EgressPolicy,
  ReplayFailedRequest,
  ReplayFailedResult,
  RotateApiKeyRequest,
  RotatedWebhookSecret,
  RotateWebhookSecretRequest,
  SetEgressHostsRequest,
  TestWebhookResult,
  UpdateWebhookEndpointRequest,
  WebhookDelivery,
  WebhookDeliveryDetail,
  WebhookDeliveryPage,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEventPage,
  WebhookEventTypeInfo,
} from './developer.js';
import type { RouteDef } from './routes.js';
import { WebhookEventType, WebhookPayload } from './webhook-events.js';

const idParam = (description: string) => z.object({ id: z.string().meta({ description }) });
const keyParams = idParam('API key ID (key_…)');
const endpointParams = idParam('Webhook endpoint ID (whe_…)');
const deliveryParams = idParam('Webhook delivery ID (whd_…)');

/** API keys (board 19). Changes need `api_keys.manage`, two-step verification and a fresh sign-in. */
export const apiKeyRoutes = {
  listApiKeys: {
    method: 'get',
    path: '/v1/admin/api-keys',
    operationId: 'listApiKeys',
    summary: 'API keys of the tenant, newest first (api_keys.read)',
    tags: ['Developer'],
    auth: 'staff_session',
    success: { status: 200, description: 'Keys', schema: z.object({ items: z.array(ApiKey) }) },
  },
  listApiKeyPermissions: {
    method: 'get',
    path: '/v1/admin/api-keys/permissions',
    operationId: 'listApiKeyPermissions',
    summary: 'What an API key can be given, and which of it you could give (api_keys.read)',
    tags: ['Developer'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Permissions',
      schema: z.object({ items: z.array(ApiKeyPermissionOption) }),
    },
  },
  createApiKey: {
    method: 'post',
    path: '/v1/admin/api-keys',
    operationId: 'createApiKey',
    summary:
      'Create a scoped, expiring API key; the key is in this response only (api_keys.manage, MFA, fresh sign-in)',
    tags: ['Developer'],
    auth: 'staff_session',
    body: CreateApiKeyRequest,
    success: { status: 201, description: 'Key created', schema: CreatedApiKey },
  },
  rotateApiKey: {
    method: 'post',
    path: '/v1/admin/api-keys/{id}/rotate',
    operationId: 'rotateApiKey',
    summary:
      'Replace a key with a new one with the same scope; the old key works for the overlap only (api_keys.manage)',
    tags: ['Developer'],
    auth: 'staff_session',
    params: keyParams,
    body: RotateApiKeyRequest,
    success: { status: 201, description: 'The new key', schema: CreatedApiKey },
  },
  revokeApiKey: {
    method: 'post',
    path: '/v1/admin/api-keys/{id}/revoke',
    operationId: 'revokeApiKey',
    summary: 'Revoke a key at once (api_keys.manage)',
    tags: ['Developer'],
    auth: 'staff_session',
    params: keyParams,
    success: { status: 200, description: 'Revoked', schema: ApiKey },
  },
  currentApiKey: {
    method: 'get',
    path: '/v1/api-keys/current',
    operationId: 'getCurrentApiKey',
    summary: 'The API key making this request: its tenant, permissions, scope and expiry',
    tags: ['Developer'],
    auth: 'api_key',
    success: { status: 200, description: 'This key', schema: ApiKeyIdentity },
  },
} as const satisfies Record<string, RouteDef>;

/** Outgoing webhooks (D06). Reads accept an API key with `webhooks.read`. */
export const webhookRoutes = {
  listWebhookEventTypes: {
    method: 'get',
    path: '/v1/admin/webhooks/event-types',
    operationId: 'listWebhookEventTypes',
    summary: 'Every event type an endpoint can subscribe to (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    success: {
      status: 200,
      description: 'Event types',
      schema: z.object({ items: z.array(WebhookEventTypeInfo) }),
    },
  },
  sampleWebhookPayload: {
    method: 'get',
    path: '/v1/admin/webhooks/event-types/{type}/sample',
    operationId: 'sampleWebhookPayload',
    summary:
      'An example body of this event type, with made-up values, to build a receiver against (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    params: z.object({ type: WebhookEventType }),
    success: { status: 200, description: 'Example body', schema: WebhookPayload },
  },
  listWebhookEndpoints: {
    method: 'get',
    path: '/v1/admin/webhooks/endpoints',
    operationId: 'listWebhookEndpoints',
    summary: 'Webhook endpoints with their health and latest delivery (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    success: {
      status: 200,
      description: 'Endpoints',
      schema: z.object({ items: z.array(WebhookEndpoint) }),
    },
  },
  createWebhookEndpoint: {
    method: 'post',
    path: '/v1/admin/webhooks/endpoints',
    operationId: 'createWebhookEndpoint',
    summary:
      'Add an HTTPS endpoint; the signing secret is in this response only (webhooks.manage, fresh sign-in)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    body: CreateWebhookEndpointRequest,
    success: { status: 201, description: 'Endpoint added', schema: CreatedWebhookEndpoint },
  },
  getWebhookEndpoint: {
    method: 'get',
    path: '/v1/admin/webhooks/endpoints/{id}',
    operationId: 'getWebhookEndpoint',
    summary: 'One endpoint (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    params: endpointParams,
    success: { status: 200, description: 'Endpoint', schema: WebhookEndpoint },
  },
  updateWebhookEndpoint: {
    method: 'patch',
    path: '/v1/admin/webhooks/endpoints/{id}',
    operationId: 'updateWebhookEndpoint',
    summary:
      'Change the address, events or description, or turn deliveries off and on (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: endpointParams,
    body: UpdateWebhookEndpointRequest,
    success: { status: 200, description: 'Endpoint', schema: WebhookEndpoint },
  },
  deleteWebhookEndpoint: {
    method: 'delete',
    path: '/v1/admin/webhooks/endpoints/{id}',
    operationId: 'deleteWebhookEndpoint',
    summary: 'Remove an endpoint, its pending deliveries and its signing secrets (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: endpointParams,
    success: { status: 204, description: 'Removed' },
  },
  rotateWebhookSecret: {
    method: 'post',
    path: '/v1/admin/webhooks/endpoints/{id}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary:
      'New signing secret; requests carry both signatures during the overlap (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: endpointParams,
    body: RotateWebhookSecretRequest,
    success: { status: 200, description: 'Rotated', schema: RotatedWebhookSecret },
  },
  testWebhookEndpoint: {
    method: 'post',
    path: '/v1/admin/webhooks/endpoints/{id}/test',
    operationId: 'testWebhookEndpoint',
    summary: 'Send a signed `webhook.test` event now and report the answer (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: endpointParams,
    success: { status: 200, description: 'Attempt result', schema: TestWebhookResult },
  },
  replayFailedWebhooks: {
    method: 'post',
    path: '/v1/admin/webhooks/endpoints/{id}/replay-failed',
    operationId: 'replayFailedWebhooks',
    summary:
      'Send failed deliveries of this endpoint again, with their original event ids (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: endpointParams,
    body: ReplayFailedRequest,
    success: { status: 200, description: 'Replays queued', schema: ReplayFailedResult },
  },
  listWebhookDeliveries: {
    method: 'get',
    path: '/v1/admin/webhooks/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'Delivery log, newest first (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    query: z.object({
      endpointId: z.string().optional(),
      status: WebhookDeliveryStatus.optional(),
      eventType: WebhookEventType.optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    success: { status: 200, description: 'Deliveries', schema: WebhookDeliveryPage },
  },
  getWebhookDelivery: {
    method: 'get',
    path: '/v1/admin/webhooks/deliveries/{id}',
    operationId: 'getWebhookDelivery',
    summary: 'One delivery with every attempt and a redacted payload (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    params: deliveryParams,
    success: { status: 200, description: 'Delivery', schema: WebhookDeliveryDetail },
  },
  replayWebhookDelivery: {
    method: 'post',
    path: '/v1/admin/webhooks/deliveries/{id}/replay',
    operationId: 'replayWebhookDelivery',
    summary:
      'Send a finished delivery again with the same event id, so receivers can deduplicate (webhooks.manage)',
    tags: ['Webhooks'],
    auth: 'staff_session',
    params: deliveryParams,
    success: { status: 201, description: 'Replay queued', schema: WebhookDelivery },
  },
  listWebhookEvents: {
    method: 'get',
    path: '/v1/admin/webhooks/events',
    operationId: 'listWebhookEvents',
    summary: 'Events sent to endpoints, newest first, with their delivery counts (webhooks.read)',
    tags: ['Webhooks'],
    auth: 'staff_or_api_key',
    query: z.object({
      type: WebhookEventType.optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }),
    success: { status: 200, description: 'Events', schema: WebhookEventPage },
  },
} as const satisfies Record<string, RouteDef>;

/** The network egress allowlist (X05). */
export const networkRoutes = {
  getEgressPolicy: {
    method: 'get',
    path: '/v1/admin/network/egress',
    operationId: 'getEgressPolicy',
    summary: 'Hosts Hamnivo may call for this tenant (webhooks.read or network.manage)',
    tags: ['Developer'],
    auth: 'staff_session',
    success: { status: 200, description: 'Policy', schema: EgressPolicy },
  },
  setEgressHosts: {
    method: 'put',
    path: '/v1/admin/network/egress',
    operationId: 'setEgressHosts',
    summary:
      'Replace the list of allowed hosts; an empty list allows any public host (network.manage, fresh sign-in)',
    tags: ['Developer'],
    auth: 'staff_session',
    body: SetEgressHostsRequest,
    success: { status: 200, description: 'Policy', schema: EgressPolicy },
  },
} as const satisfies Record<string, RouteDef>;
