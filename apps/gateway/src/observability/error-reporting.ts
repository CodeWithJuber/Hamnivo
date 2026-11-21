/**
 * Error tracking (O01): errors nobody expected, from the API, the worker, Studio and the chat, go
 * to a Sentry-compatible server (Sentry, or a self-hosted GlitchTip) when SENTRY_DSN is set.
 *
 * Errors only: no tracing, and none of the data Sentry collects by default (users, cookies,
 * headers, bodies, query strings, AI prompts and replies): chats carry customers' personal data.
 * Without a DSN, `reportError` does nothing, so callers never need to check.
 */
import * as Sentry from '@sentry/node';

export type ReportingApp = 'api' | 'worker';

/** Starts error tracking for this process; false when no DSN is set. */
export function startErrorReporting(app: ReportingApp, env: NodeJS.ProcessEnv = process.env) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || 'development',
    // The commit the image was built from (deploy/docker/Dockerfile).
    ...(env.HAMNIVO_RELEASE?.trim() ? { release: env.HAMNIVO_RELEASE.trim() } : {}),
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    // No tracing: without a sample rate, Sentry sends errors only. No release-health sessions
    // either: a server process is not a user session, and GlitchTip does not take them.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== 'ProcessSession'),
    initialScope: { tags: { app: `gateway-${app}` } },
  });
  return true;
}

/** An error that was caught and logged but should not have happened. */
export function reportError(error: unknown, extra?: Record<string, string | number>): void {
  Sentry.captureException(error, extra ? { extra } : undefined);
}

/** Sends what is queued before the process exits. */
export async function flushErrorReports(timeoutMs = 2000): Promise<void> {
  await Sentry.flush(timeoutMs);
}
