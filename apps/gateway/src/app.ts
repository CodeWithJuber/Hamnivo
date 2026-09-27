import 'reflect-metadata';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { ApiModule } from './api.module.js';
import { ProblemFilter } from './common/problem.filter.js';
import { requestIdFrom } from './common/request-id.js';
import type { AppConfig } from './config.js';
import type { Auth } from './identity/auth.factory.js';
import { registerAuthRoutes } from './identity/auth.routes.js';
import { registerApiDocs } from './platform/docs.js';
import { registerMetrics } from './platform/metrics.js';
import type { PlatformOverrides } from './platform/platform.module.js';
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
  overrides: PlatformOverrides = {},
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
    { logger: config.NODE_ENV === 'test' ? false : ['error', 'warn', 'log'] },
  );
  app.useGlobalFilters(new ProblemFilter());
  app.enableCors({
    origin: [config.PUBLIC_CONSOLE_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-hamnivo-tenant', 'idempotency-key', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
  });

  const fastify = app.getHttpAdapter().getInstance();
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
    allowList: (request) => request.url.startsWith('/health'),
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
  registerAuthRoutes(fastify, app.get<Auth>(AUTH));
  registerMetrics(fastify, config.METRICS_TOKEN);
  await registerApiDocs(fastify, config.API_DOCS);
  await app.init();
  return app;
}
