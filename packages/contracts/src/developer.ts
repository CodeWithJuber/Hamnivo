import { z } from 'zod';
import { GrantScope } from './admin.js';
import { Cursor, Timestamp } from './common.js';
import { typeId } from './ids.js';
import { WebhookEventType } from './webhook-events.js';

/**
 * Developer platform (board 19): API keys for server integrations, outgoing webhook endpoints
 * with their delivery log, and the network egress allowlist. Secrets (API keys, signing secrets)
 * appear in exactly one response, the one that creates or rotates them.
 */

// ── API keys ───────────────────────────────────────────────────────────────────────────────

/** What an API key can be given (mirrors API_KEY_PERMISSIONS in @hamnivo/policy). */
export const ApiKeyPermission = z
  .enum(['analytics.read', 'billing.read', 'webhooks.read', 'mcp.read'])
  .meta({ id: 'ApiKeyPermission' });
export type ApiKeyPermission = z.infer<typeof ApiKeyPermission>;

export const ApiKeyStatus = z.enum([
  'active',
  /** Replaced by a rotation; still accepted until `expiresAt`. */
  'rotating',
  'expired',
  'revoked',
]);

const PersonRef = z.object({ id: typeId('staff'), name: z.string() });

export const ApiKey = z
  .object({
    id: typeId('apiKey'),
    name: z.string(),
    /** The public part, e.g. `hv_live_8f3k2m1qa9bc`; the secret after it is never shown again. */
    prefix: z.string(),
    permissions: z.array(ApiKeyPermission),
    /** Where the key's permissions apply. */
    scope: GrantScope,
    status: ApiKeyStatus,
    serviceAccountId: typeId('serviceAccount'),
    createdAt: Timestamp,
    createdBy: PersonRef.nullable(),
    expiresAt: Timestamp,
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
    /** The key that replaced this one in a rotation. */
    replacedBy: typeId('apiKey').nullable(),
  })
  .meta({ id: 'ApiKey' });
export type ApiKey = z.infer<typeof ApiKey>;

export const CreateApiKeyRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    permissions: z.array(ApiKeyPermission).min(1).max(10),
    scope: GrantScope.default({ type: 'tenant' }),
    /** Every key expires: 1 to 365 days. */
    expiresInDays: z.int().min(1).max(365),
  })
  .meta({ id: 'CreateApiKeyRequest' });

export const CreatedApiKey = ApiKey.extend({
  /** The whole key, shown in this response only. Store it in a secret manager. */
  secret: z.string(),
}).meta({ id: 'CreatedApiKey' });
export type CreatedApiKey = z.infer<typeof CreatedApiKey>;

export const RotateApiKeyRequest = z
  .object({
    /** How long the old key keeps working, so deployments can switch (0 to 7 days). */
    overlapMinutes: z.int().min(0).max(10_080).default(60),
  })
  .meta({ id: 'RotateApiKeyRequest' });

export const ApiKeyPermissionOption = z.object({
  permission: ApiKeyPermission,
  description: z.string(),
  /** Whether the caller holds it (a key can never have more than its creator). */
  grantable: z.boolean(),
});

/** What the key making the request is (GET /v1/api-keys/current). */
export const ApiKeyIdentity = z
  .object({
    id: typeId('apiKey'),
    name: z.string(),
    tenantId: typeId('tenant'),
    permissions: z.array(ApiKeyPermission),
    scope: GrantScope,
    expiresAt: Timestamp,
  })
  .meta({ id: 'ApiKeyIdentity' });
export type ApiKeyIdentity = z.infer<typeof ApiKeyIdentity>;

// ── Webhook endpoints ──────────────────────────────────────────────────────────────────────

export const WebhookEndpointStatus = z.enum([
  'active',
  /** Deliveries keep failing; retries continue until the endpoint is disabled. */
  'failing',
  'disabled',
]);

export const WebhookDeliveryStatus = z.enum(['pending', 'succeeded', 'failed', 'cancelled']);

export const WebhookAttemptOutcome = z.enum([
  'succeeded',
  'http_error',
  'redirect',
  'timeout',
  'network',
  'tls',
  'blocked',
  'unresolvable',
]);

export const WebhookDeliverySummary = z.object({
  id: typeId('webhookDelivery'),
  eventType: WebhookEventType,
  status: WebhookDeliveryStatus,
  lastStatusCode: z.int().nullable(),
  at: Timestamp,
});

export const WebhookEndpoint = z
  .object({
    id: typeId('webhookEndpoint'),
    url: z.string(),
    description: z.string().nullable(),
    eventTypes: z.array(WebhookEventType),
    status: WebhookEndpointStatus,
    /** `manual`: someone turned it off. `failing`: it kept failing. `gone`: it answered 410. */
    disabledReason: z.enum(['manual', 'failing', 'gone']).nullable(),
    disabledAt: Timestamp.nullable(),
    /** When a signed test event was last accepted. */
    verifiedAt: Timestamp.nullable(),
    secret: z.object({
      /** Last characters of the signing secret. */
      hint: z.string(),
      rotatedAt: Timestamp.nullable(),
      /** While set, requests also carry a signature made with the previous secret. */
      previousValidUntil: Timestamp.nullable(),
    }),
    health: z.object({
      consecutiveFailures: z.int().nonnegative(),
      failingSince: Timestamp.nullable(),
      lastSuccessAt: Timestamp.nullable(),
      lastFailureAt: Timestamp.nullable(),
    }),
    /** Delivery would be refused by the network allowlist as it stands. */
    blockedByAllowlist: z.boolean(),
    latestDelivery: WebhookDeliverySummary.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    version: z.int().positive(),
  })
  .meta({ id: 'WebhookEndpoint' });
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

const EndpointUrl = z
  .string()
  .trim()
  .min(8)
  .max(2000)
  .meta({ description: 'HTTPS address of your endpoint', example: 'https://hooks.example.com/hv' });

export const CreateWebhookEndpointRequest = z
  .object({
    url: EndpointUrl,
    description: z.string().trim().max(200).optional(),
    eventTypes: z.array(WebhookEventType).min(1).max(50),
  })
  .meta({ id: 'CreateWebhookEndpointRequest' });

export const CreatedWebhookEndpoint = WebhookEndpoint.extend({
  /** `whsec_…`, shown in this response only. */
  signingSecret: z.string(),
}).meta({ id: 'CreatedWebhookEndpoint' });
export type CreatedWebhookEndpoint = z.infer<typeof CreatedWebhookEndpoint>;

export const UpdateWebhookEndpointRequest = z
  .object({
    url: EndpointUrl.optional(),
    description: z.string().trim().max(200).nullable().optional(),
    eventTypes: z.array(WebhookEventType).min(1).max(50).optional(),
    /** `disabled` stops deliveries; `active` resumes them and resets the failure count. */
    status: z.enum(['active', 'disabled']).optional(),
    /** The version you read; a different current version is VERSION_CONFLICT. */
    version: z.int().positive(),
  })
  .meta({ id: 'UpdateWebhookEndpointRequest' });

export const RotateWebhookSecretRequest = z
  .object({
    /** How long the previous secret still signs requests (0 to 72 hours). */
    overlapHours: z.int().min(0).max(72).default(24),
  })
  .meta({ id: 'RotateWebhookSecretRequest' });

export const RotatedWebhookSecret = z
  .object({
    endpoint: WebhookEndpoint,
    /** The new `whsec_…`, shown in this response only. */
    signingSecret: z.string(),
  })
  .meta({ id: 'RotatedWebhookSecret' });
export type RotatedWebhookSecret = z.infer<typeof RotatedWebhookSecret>;

// ── Deliveries and events ──────────────────────────────────────────────────────────────────

export const WebhookAttempt = z
  .object({
    attempt: z.int().positive(),
    startedAt: Timestamp,
    durationMs: z.int().nonnegative(),
    statusCode: z.int().nullable(),
    outcome: WebhookAttemptOutcome,
    /** A short, safe explanation (no response content). */
    error: z.string().nullable(),
    /** The first characters of the response body, with anything like a secret removed. */
    responseExcerpt: z.string().nullable(),
  })
  .meta({ id: 'WebhookAttempt' });

export const WebhookDelivery = z
  .object({
    id: typeId('webhookDelivery'),
    endpointId: typeId('webhookEndpoint'),
    endpointUrl: z.string(),
    eventId: typeId('event'),
    eventType: WebhookEventType,
    status: WebhookDeliveryStatus,
    attempts: z.int().nonnegative(),
    maxAttempts: z.int().positive(),
    nextAttemptAt: Timestamp.nullable(),
    lastAttemptAt: Timestamp.nullable(),
    lastStatusCode: z.int().nullable(),
    lastOutcome: WebhookAttemptOutcome.nullable(),
    succeededAt: Timestamp.nullable(),
    createdAt: Timestamp,
    /** Set on a replay: the delivery it repeats. */
    replayOf: typeId('webhookDelivery').nullable(),
  })
  .meta({ id: 'WebhookDelivery' });
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

export const WebhookDeliveryDetail = WebhookDelivery.extend({
  attemptLog: z.array(WebhookAttempt),
  /**
   * The event body with customer text, names and addresses replaced by `[redacted]`; null once
   * the event is past its retention.
   */
  payloadPreview: z.record(z.string(), z.unknown()).nullable(),
  /** Whether the event can still be replayed (it is kept for a limited time). */
  replayable: z.boolean(),
}).meta({ id: 'WebhookDeliveryDetail' });
export type WebhookDeliveryDetail = z.infer<typeof WebhookDeliveryDetail>;

export const WebhookDeliveryPage = z.object({
  items: z.array(WebhookDelivery),
  nextCursor: Cursor.nullable(),
});

export const WebhookEventSummary = z
  .object({
    id: typeId('event'),
    type: WebhookEventType,
    occurredAt: Timestamp,
    deliveries: z.object({
      total: z.int().nonnegative(),
      succeeded: z.int().nonnegative(),
      failed: z.int().nonnegative(),
      pending: z.int().nonnegative(),
    }),
  })
  .meta({ id: 'WebhookEventSummary' });

export const WebhookEventPage = z.object({
  items: z.array(WebhookEventSummary),
  nextCursor: Cursor.nullable(),
});

export const WebhookEventTypeInfo = z.object({
  type: WebhookEventType,
  category: z.string(),
  description: z.string(),
});

export const TestWebhookResult = z
  .object({
    delivery: WebhookDelivery,
    attempt: WebhookAttempt,
    /** The endpoint answered 2xx to a signed test event. */
    verified: z.boolean(),
  })
  .meta({ id: 'TestWebhookResult' });
export type TestWebhookResult = z.infer<typeof TestWebhookResult>;

export const ReplayFailedRequest = z
  .object({
    /** Replays failed deliveries of this endpoint created at or after this time. */
    since: Timestamp,
  })
  .meta({ id: 'ReplayFailedRequest' });

export const ReplayFailedResult = z.object({
  replayed: z.int().nonnegative(),
  /** Failed deliveries whose event is past its retention and cannot be sent again. */
  expired: z.int().nonnegative(),
});

// ── Network egress allowlist (X05) ─────────────────────────────────────────────────────────

export const EgressHost = z.object({
  /** `hooks.example.com`, or `*.example.com` for every subdomain (not the apex itself). */
  pattern: z.string(),
  note: z.string().nullable(),
  createdAt: Timestamp,
});

export const EgressPolicy = z
  .object({
    /** `any_public_host` while the list is empty; private networks are refused either way. */
    mode: z.enum(['any_public_host', 'allowlist']),
    hosts: z.array(EgressHost),
    /** Endpoints whose host the list does not allow: their deliveries are refused. */
    blockedEndpoints: z.array(z.object({ id: typeId('webhookEndpoint'), url: z.string() })),
    version: z.int().nonnegative(),
  })
  .meta({ id: 'EgressPolicy' });
export type EgressPolicy = z.infer<typeof EgressPolicy>;

export const SetEgressHostsRequest = z
  .object({
    hosts: z
      .array(
        z.object({
          pattern: z.string().trim().min(1).max(253),
          note: z.string().trim().max(200).optional(),
        }),
      )
      .max(100),
    /** The version you read (0 when there is no list yet). */
    version: z.int().nonnegative(),
  })
  .meta({ id: 'SetEgressHostsRequest' });
