import { createDocument } from 'zod-openapi';
import { Problem } from '../src/errors.js';
import type { RouteDef } from '../src/routes.js';

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
  apiKey: { type: 'http', scheme: 'bearer', description: 'Scoped API key (hv_…)' },
  chatwootSignature: {
    type: 'apiKey',
    in: 'header',
    name: 'X-Chatwoot-Signature',
    description:
      'sha256=HMAC-SHA256(secret, "{X-Chatwoot-Timestamp}.{raw body}") with the secret of the account, inbox or bot webhook',
  },
} as const;

const securityFor: Record<RouteDef['auth'], Record<string, string[]>[] | undefined> = {
  public: [],
  widget_session: [{ widgetSession: [] }],
  staff_session: [{ staffSession: [] }],
  api_key: [{ apiKey: [] }],
  integration_signature: [{ chatwootSignature: [] }],
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
    const parameters: Record<string, unknown>[] = [];
    if (
      route.path.startsWith('/v1/admin/') ||
      route.path.startsWith('/v1/conversations/') ||
      route.path.startsWith('/v1/inbox/') ||
      route.path.startsWith('/v1/workspace/')
    ) {
      parameters.push({
        in: 'header',
        name: 'X-Hamnivo-Tenant',
        required: true,
        description: 'Tenant the request acts in (tnt_…); the caller must be an active member',
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
  return createDocument({
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
  });
}
