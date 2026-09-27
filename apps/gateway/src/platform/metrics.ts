import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics (O01): process defaults plus request latency by route template and status.
 * GET /metrics requires `Authorization: Bearer <METRICS_TOKEN>`; without a token it is disabled.
 */
export function registerMetrics(fastify: FastifyInstance, token: string | undefined): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'hamnivo_' });
  const latency = new Histogram({
    name: 'hamnivo_http_request_duration_seconds',
    help: 'HTTP request duration by route template',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    latency.observe(
      { method: request.method, route, status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  fastify.get('/metrics', async (request, reply) => {
    const expected = token ? Buffer.from(`Bearer ${token}`) : null;
    const given = Buffer.from(request.headers.authorization ?? '');
    if (!expected || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.status(404).send();
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
  return registry;
}
