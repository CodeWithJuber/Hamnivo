import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BrandingService } from '../branding/branding.service.js';
import { portalHostname } from '../branding/branding.service.js';
import type { AppConfig } from '../config.js';
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
export function registerAuthRoutes(
  fastify: FastifyInstance,
  auth: Auth,
  sso: SsoRuntime,
  branding: BrandingService,
  config: AppConfig,
): void {
  const portals = new Map<string, Pick<Auth, 'handler'>>();
  const canonicalHost = new URL(config.PUBLIC_API_ORIGIN).hostname;
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const hostname = portalHostname(request.headers.host);
      // Fixed canonical behavior remains the default; a configured custom host must still have
      // live DNS ownership in the database. Forwarded Host never decides authentication origin.
      const custom = hostname !== null && config.PORTAL_CUSTOM_HOSTS.includes(hostname);
      let requestAuth: Pick<Auth, 'handler'> = auth;
      let baseURL = config.PUBLIC_API_ORIGIN;
      if (custom) {
        const portal = await branding.resolve(hostname);
        if (!portal)
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Portal unavailable' });
        baseURL = `https://${hostname}`;
        // Better Auth deliberately skips some origin checks on a first login with no cookie.
        // Custom portals are browser-only same-origin surfaces, including that first request.
        if (
          (request.method === 'POST' || request.headers.origin) &&
          request.headers.origin !== baseURL
        ) {
          return reply
            .status(403)
            .send({ code: 'INVALID_ORIGIN', message: 'Use this portal origin.' });
        }
        let found = portals.get(hostname);
        if (!found) {
          found = betterAuth({
            ...auth.options,
            baseURL,
            trustedOrigins: [baseURL],
            // Explicit even under NODE_ENV=test: security tests exercise real callback checks.
            advanced: {
              ...auth.options.advanced,
              disableOriginCheck: false,
              disableCSRFCheck: false,
            },
          });
          portals.set(hostname, found);
        }
        requestAuth = found;
        // Passkeys are scoped to the canonical RP ID; enterprise SSO has a registered canonical
        // callback. These flows must begin on the canonical portal until per-domain setup exists.
        if (
          /^\/api\/auth\/(?:passkey(?:\/|$)|sso(?:\/|$)|sign-in\/sso(?:\?|$))/.test(request.url)
        ) {
          return reply.status(403).send({
            code: 'CANONICAL_SIGN_IN_REQUIRED',
            message: `Use ${config.PUBLIC_CONSOLE_ORIGIN} for passkeys or enterprise SSO.`,
          });
        }
      } else if (hostname !== canonicalHost && config.NODE_ENV === 'production') {
        return reply
          .status(404)
          .send({ code: 'NOT_FOUND', message: 'Unknown authentication host' });
      }
      const url = new URL(request.url, baseURL);
      if (!ssoPathAllowed(url.pathname)) {
        return reply.status(404).send({ code: 'NOT_FOUND', message: 'Not found' });
      }
      const body = request.method === 'GET' ? undefined : requestBody(request);
      const response = await sso.run(url.pathname, body, () =>
        requestAuth.handler(
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
