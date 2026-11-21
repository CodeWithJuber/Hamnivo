/**
 * Studio's own errors go to the error tracker (O01), through Hamnivo's API: Studio's CSP allows
 * no other host, and the tracker never learns the staff member's address.
 *
 * Nothing loads until an error happens. Then the API says whether tracking is on, and only then is
 * the Sentry SDK downloaded and the error sent. Only the error and its stack are sent: no
 * breadcrumbs, cookies, query strings or conversation text. The widget has the same module.
 */
import { ApiError } from './api';

type SentrySdk = typeof import('@sentry/browser');

interface Settings {
  dsn: string | null;
  environment: string;
  release: string | null;
}

let api = '';
let ready: Promise<SentrySdk | null> | undefined;

async function start(): Promise<SentrySdk | null> {
  const response = await fetch(`${api}/v1/error-reporting`);
  if (!response.ok) return null;
  const settings = (await response.json()) as Settings;
  if (!settings.dsn) return null;
  const Sentry = await import('@sentry/browser');
  Sentry.init({
    dsn: settings.dsn,
    tunnel: `${api}/v1/error-reports`,
    environment: settings.environment,
    ...(settings.release ? { release: settings.release } : {}),
    // Errors arrive from watchErrors below; nothing else is recorded.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.httpContextIntegration(),
    ],
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    initialScope: { tags: { app: 'studio' } },
    beforeSend(event) {
      // An address's query can carry what was searched for: keep the path only.
      if (event.request?.url) event.request.url = event.request.url.split(/[?#]/)[0];
      return event;
    },
  });
  return Sentry;
}

/**
 * Sends an error to the tracker, when the server has one. An answer the API gave on purpose (a
 * 4xx: no permission, not found, invalid) is not a fault and is not sent.
 */
export function reportError(error: unknown): void {
  if (error instanceof ApiError && error.status < 500) return;
  ready ??= start().catch((failure: unknown) => {
    // Tracking stays off for this page; Studio itself is not affected.
    console.warn('Error reporting is unavailable', failure);
    return null;
  });
  void ready.then((Sentry) => Sentry?.captureException(error));
}

/**
 * Reports what nothing else caught, from Studio's first line on. React passes render errors
 * nobody caught to the page's error event too; a page's own errors come from PageError. Errors
 * from other origins' scripts arrive without an error object ("Script error.") and are left out.
 */
export function watchErrors(apiBase: string): void {
  api = apiBase.replace(/\/+$/, '');
  window.addEventListener('error', (event) => {
    if (event.error) reportError(event.error);
  });
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
}
