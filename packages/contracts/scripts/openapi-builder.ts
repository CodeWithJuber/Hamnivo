import { createDocument } from 'zod-openapi';
import { Problem } from '../src/errors.js';
import type { RouteDef } from '../src/routes.js';
import { WEBHOOK_EVENT_CATALOG, WebhookPayload } from '../src/webhook-events.js';

type Operation = Record<string, unknown>;

const securitySchemes = {
  widgetSession: {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Widget access token',
  },
  staffSession: {
    type: 'apiKey',
    in: 'cookie',
    name: 'hamnivo.session_token',
    description: 'Hamnivo Studio session',
  },
  apiKey: {
    type: 'http',
    scheme: 'bearer',
    description: 'Scoped, expiring API key (hv_live_…); the tenant is the key’s own',
  },
  chatwootSignature: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Chatwoot-Signature',
    description:
      'sha256=HMAC-SHA256(secret, "{X-Chatwoot-Timestamp}.{raw body}") with the secret of the account, inbox or bot webhook',
  },
  stripeSignature: {
    type: 'apiKey',
    in: 'header',
    name: 'Stripe-Signature',
    description:
      't={timestamp},v1=HMAC-SHA256(signing secret, "{timestamp}.{raw body}"), checked with the Stripe SDK',
  },
} as const;

const securityFor: Record<RouteDef['auth'], Record<string, string[]>[] | undefined> = {
  public: [],
  widget_session: [{ widgetSession: [] }],
  staff_session: [{ staffSession: [] }],
  api_key: [{ apiKey: [] }],
  staff_or_api_key: [{ staffSession: [] }, { apiKey: [] }],
  integration_signature: [{ chatwootSignature: [] }],
  provider_signature: [{ stripeSignature: [] }],
};

/** Builds the OpenAPI 3.1 document from route definitions (contract-first; no running server). */
export function buildOpenApi(
  routes: Record<string, RouteDef>,
  version: string,
): ReturnType<typeof createDocument> {
  const paths: Record<string, Record<string, Operation>> = {};
  for (const route of Object.values(routes)) {
    const operation: Operation = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      security: securityFor[route.auth],
      requestParams: {
        ...(route.params ? { path: route.params } : {}),
        ...(route.query ? { query: route.query } : {}),
      },
      responses: {
        [String(route.success.status)]: {
          description: route.success.description,
          ...(route.success.schema
            ? {
                content: {
                  [route.success.contentType ?? 'application/json']: {
                    schema: route.success.schema,
                  },
                },
              }
            : {}),
        },
        default: {
          description: 'Error (RFC 9457 problem details)',
          content: { 'application/problem+json': { schema: Problem } },
        },
      },
    };
    if (route.body)
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: route.body } },
      };
    if (route.rawBody)
      operation.requestBody = {
        required: true,
        description: route.rawBody.description,
        content: { [route.rawBody.contentType]: { schema: { type: 'string', format: 'binary' } } },
      };
    const parameters: Record<string, unknown>[] = [];
    if (
      route.path.startsWith('/v1/admin/') ||
      route.path.startsWith('/v1/conversations/') ||
      route.path.startsWith('/v1/inbox/') ||
      route.path.startsWith('/v1/workspace/')
    ) {
      const keyAllowed = route.auth === 'staff_or_api_key';
      parameters.push({
        in: 'header',
        name: 'X-Hamnivo-Tenant',
        required: !keyAllowed,
        description: keyAllowed
          ? 'Tenant the request acts in (tnt_…); required with a staff session. With an API key the tenant is the key’s own, and a different value is refused'
          : 'Tenant the request acts in (tnt_…); the caller must be an active member',
        schema: { type: 'string' },
      });
    }
    if (route.idempotent) {
      parameters.push({
        in: 'header',
        name: 'Idempotency-Key',
        required: false,
        description:
          'Retry-safe key bound to the request body hash; reuse with a different body returns 409',
        schema: { type: 'string', maxLength: 255 },
      });
    }
    if (parameters.length > 0) operation.parameters = parameters;
    paths[route.path] ??= {};
    (paths[route.path] as Record<string, Operation>)[route.method] = operation;
  }
  // Outgoing webhooks (OpenAPI 3.1 `webhooks`): what Hamnivo sends to a registered endpoint.
  const signatureHeaders = [
    {
      in: 'header',
      name: 'webhook-id',
      required: true,
      description: 'Event id (evt_…), the same on retries and replays: deduplicate on it',
      schema: { type: 'string' },
    },
    {
      in: 'header',
      name: 'webhook-timestamp',
      required: true,
      description: 'Unix seconds of this attempt; refuse values far from your clock',
      schema: { type: 'string' },
    },
    {
      in: 'header',
      name: 'webhook-signature',
      required: true,
      description:
        'Space-separated `v1,<base64 HMAC-SHA256(secret, "{webhook-id}.{webhook-timestamp}.{raw body}")>`, one per active signing secret (Standard Webhooks)',
      schema: { type: 'string' },
    },
  ];
  const webhooks: Record<string, Record<string, Operation>> = {};
  for (const [type, info] of Object.entries(WEBHOOK_EVENT_CATALOG)) {
    webhooks[type] = {
      post: {
        operationId: `webhook_${type.replaceAll('.', '_')}`,
        summary: info.description,
        tags: ['Webhook events'],
        parameters: signatureHeaders,
        // A reference, not the schema itself: rendered as a request body, shared schemas such as
        // Message would get a second (input) definition.
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/WebhookPayload' } },
          },
        },
        responses: {
          '200': { description: 'Any 2xx acknowledges the event; anything else is retried' },
        },
      },
    };
  }
  const document = createDocument({
    openapi: '3.1.0',
    info: {
      title: 'Hamnivo API',
      version,
      description:
        "Public API for Hamnivo. Every request is authorized against the caller's tenant, scope and " +
        'resource; identifiers are never authorization by themselves. Errors use RFC 9457 problem details.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: 'https://api.hamnivo.example', description: 'Replace with your deployment' }],
    components: { securitySchemes },
    paths: paths as never,
    webhooks: webhooks as never,
  });
  // The webhook bodies point at the WebhookPayload component, which the sample-payload route
  // renders as a response: one definition for what Hamnivo sends, shared with the API.
  if (!document.components?.schemas?.[WebhookPayload.meta()?.id as string]) {
    throw new Error('WebhookPayload is not rendered by any route');
  }
  return document;
}
