import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from './auth.factory.js';
import type { SsoRuntime } from './sso/sso-runtime.js';

function requestBody(request: FastifyRequest): string | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  if (typeof request.body === 'string') return request.body;
  const type = String(request.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) {
    return new URLSearchParams(request.body as Record<string, string>).toString();
  }
  return JSON.stringify(request.body);
}

/**
 * The only SSO endpoints in use: starting a sign-in and the provider's callback. Every other path
 * of the SSO plugin (provider registration, SAML) is closed; tenants manage SSO in Hamnivo.
 */
function ssoPathAllowed(pathname: string): boolean {
  if (!pathname.startsWith('/api/auth/sso/')) return true;
  return /^\/api\/auth\/sso\/callback\/[A-Za-z0-9_]+$/.test(pathname);
}

/** Mounts Better Auth's fetch handler at /api/auth/* on the Fastify instance. */
export function registerAuthRoutes(fastify: FastifyInstance, auth: Auth, sso: SsoRuntime): void {
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, auth.options.baseURL as string);
      if (!ssoPathAllowed(url.pathname)) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' });
      }
      const body = request.method === 'GET' ? undefined : requestBody(request);
      const response = await sso.run(url.pathname, body, () =>
        auth.handler(
          new Request(url, {
            method: request.method,
            headers: fromNodeHeaders(request.headers),
            body,
          }),
        ),
      );
      if (url.pathname.startsWith('/api/auth/sso/callback/')) {
        // The provider's callback only redirects. Signing in again over a page (Studio's sign-in
        // dialog) goes through it in a small window that reports back to the page that opened
        // it; an opener policy on this hop would cut that link, so it has none.
        reply.raw.removeHeader('cross-origin-opener-policy');
      }
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
