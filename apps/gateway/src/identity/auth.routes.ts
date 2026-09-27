import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from './auth.factory.js';

function requestBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === 'string') return request.body;
  const type = String(request.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return new URLSearchParams(request.body as Record<string, string>).toString();
  }
  return JSON.stringify(request.body);
}

/** Mounts Better Auth's fetch handler at /api/auth/* on the Fastify instance. */
export function registerAuthRoutes(fastify: FastifyInstance, auth: Auth): void {
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, auth.options.baseURL as string);
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          body: request.method === 'GET' ? undefined : requestBody(request),
        }),
      );
      reply.status(response.status);
      for (const [key, value] of response.headers) {
        if (key === 'set-cookie') continue;
        reply.header(key, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(response.body ? await response.text() : null);
    },
  });
}
