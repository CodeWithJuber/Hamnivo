/**
 * Where Studio finds the gateway and the widget. A <meta name="hamnivo-…"> tag in index.html wins
 * over the build-time VITE_HAMNIVO_* value, so a server can point one build at another gateway.
 */
function setting(name: string, built: string | undefined): string | undefined {
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  return meta ? meta.content : built;
}

const trim = (value: string) => value.trim().replace(/\/+$/, '');

// The Vite dev server passes /v1 and /api/auth on to the gateway (vite.config.ts), so development
// stays same-origin by default. Production builds name the API origin (deploy/docker/Dockerfile).
const DEFAULT_API = import.meta.env.DEV ? '' : 'http://localhost:4000';

/** Base URL of API requests; empty means this origin. */
export const API_BASE = trim(
  setting('hamnivo-api', import.meta.env.VITE_HAMNIVO_API) ?? DEFAULT_API,
);

/** Gateway origin for the install snippet's data-api (the widget calls it directly). */
export const GATEWAY_ORIGIN = trim(
  setting('hamnivo-gateway-origin', import.meta.env.VITE_HAMNIVO_GATEWAY_ORIGIN) ||
    API_BASE ||
    'http://localhost:4000',
);

/** Origin that serves loader.js and the widget. */
export const WIDGET_ORIGIN = trim(
  setting('hamnivo-widget-origin', import.meta.env.VITE_HAMNIVO_WIDGET_ORIGIN) ||
    'http://localhost:5174',
);

/** Absolute URL for Better Auth, which needs an origin even when requests stay same-origin. */
export const AUTH_BASE = `${API_BASE || window.location.origin}/api/auth`;
