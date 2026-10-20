import 'reflect-metadata';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { ApiModule, type ApiOverrides } from './api.module.js';
import { BrandingService } from './branding/branding.service.js';
import { ProblemFilter } from './common/problem.filter.js';
import { requestIdFrom } from './common/request-id.js';
import type { AppConfig } from './config.js';
import type { Auth } from './identity/auth.factory.js';
import { registerAuthRoutes } from './identity/auth.routes.js';
import { SsoRuntime } from './identity/sso/sso-runtime.js';
import { registerApiDocs } from './platform/docs.js';
import { registerMetrics } from './platform/metrics.js';

import { AUTH, REDIS } from './tokens.js';

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/** Builds the API application (used by main.api.ts and by the integration tests). */
export async function createApiApp(
  config: AppConfig,
  overrides: ApiOverrides = {},
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger:
      config.LOG_LEVEL === 'silent'
        ? false
        : { level: config.LOG_LEVEL, redact: { paths: REDACT, censor: '[redacted]' } },
    genReqId: (request: { headers: Record<string, string | string[] | undefined> }) =>
      requestIdFrom(request.headers['x-request-id']),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    ApiModule.forRoot(config, overrides),
    adapter,
    // Raw bodies are kept for webhook signature checks (HMAC over the exact bytes).
    { rawBody: true, logger: config.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'] },
  );
  app.useGlobalFilters(new ProblemFilter());
  // Studio uses cookies from its own origin; the widget iframe uses bearer tokens and no cookies.
  const consoleCors = {
    origin: [config.PUBLIC_CONSOLE_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'x-hamnivo-tenant',
      'idempotency-key',
      'x-request-id',
      // The Cloudflare Turnstile token of a sign-up.
      'x-captcha-response',
    ],
    exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
  };
  const widgetCors = {
    origin: [config.PUBLIC_WIDGET_ORIGIN],
    credentials: false,
    methods: ['GET', 'POST'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'last-event-id',
      'x-request-id',
    ],
    exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
    maxAge: 600,
  };
  app.enableCors({
    delegator: (
      request: { url?: string },
      callback: (error: Error | null, options: object) => void,
    ) => callback(null, request.url?.startsWith('/v1/widget/') ? widgetCors : consoleCors),
  } as never);

  const fastify = app.getHttpAdapter().getInstance();
  // Knowledge uploads carry up to 5 MB and migration exports up to 20 MB as base64, and customer
  // files up to 10 MB as raw bytes; every other route keeps the 1 MB limit.
  fastify.addHook('onRoute', (route) => {
    if (route.url.startsWith('/v1/admin/knowledge/')) route.bodyLimit = 8 * 1024 * 1024;
    if (route.url === '/v1/admin/migrations' && route.method === 'POST') {
      route.bodyLimit = 28 * 1024 * 1024;
    }
    if (route.url === '/v1/widget/conversations/:conversationId/uploads') {
      route.bodyLimit = 10 * 1024 * 1024 + 1024;
    }
  });
  // Customer files arrive as their own bytes (W09); the route checks size, type and content.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (_request: unknown, body: Buffer, done: (error: Error | null, value?: Buffer) => void) =>
      done(null, body),
  );
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_PER_MINUTE,
    timeWindow: '1 minute',
    redis: app.get<Redis>(REDIS),
    nameSpace: 'hamnivo:rate:',
    skipOnError: true,
    // Webhooks are signature-checked and arrive from one Chatwoot address in bursts.
    allowList: (request) =>
      request.url.startsWith('/health') || request.url.startsWith('/v1/integrations/'),
  });
  // Errors raised outside handlers (body parsing, rate limits, 404) reach ProblemFilter through
  // Nest's Fastify error handler as well.
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', String(request.id));
    // The API reference page needs to run its own scripts and styles.
    if (request.url.startsWith('/docs')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
    }
  });
  registerAuthRoutes(
    fastify,
    app.get<Auth>(AUTH),
    app.get(SsoRuntime),
    app.get(BrandingService),
    config,
  );
  registerMetrics(fastify, config.METRICS_TOKEN);
  await registerApiDocs(fastify, config.API_DOCS);
  await app.init();
  return app;
}
