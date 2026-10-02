import type { EgressError, EgressResponse } from '@hamnivo/adapters/net';

/**
 * How a webhook attempt is judged and when the next one comes (Standard Webhooks: 2xx is
 * success; redirects are failures, not followed; 410 turns the endpoint off; Retry-After is
 * respected; retries back off exponentially with jitter over about three days).
 */

/** Delays after attempt 1, 2, … (the schedule suggested by Standard Webhooks). */
export const RETRY_DELAYS_MS = [
  5_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  5 * 3_600_000,
  10 * 3_600_000,
  14 * 3_600_000,
  20 * 3_600_000,
  24 * 3_600_000,
] as const;

export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** A Retry-After longer than this is not waited for (the delivery would outlive its retries). */
const MAX_RETRY_AFTER_MS = 24 * 3_600_000;

export type AttemptOutcome =
  | 'succeeded'
  | 'http_error'
  | 'redirect'
  | 'timeout'
  | 'network'
  | 'tls'
  | 'blocked'
  | 'unresolvable';

export interface Judgement {
  outcome: AttemptOutcome;
  statusCode: number | null;
  /** A short, safe explanation; never response content. */
  error: string | null;
  /** The endpoint asked not to be called again (410 Gone). */
  gone: boolean;
  /** Milliseconds the endpoint asked us to wait (Retry-After), when it did. */
  retryAfterMs: number | null;
}

function retryAfter(header: string | string[] | undefined, now: number): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function judgeResponse(response: EgressResponse, now = Date.now()): Judgement {
  const status = response.status;
  if (status >= 200 && status < 300) {
    return {
      outcome: 'succeeded',
      statusCode: status,
      error: null,
      gone: false,
      retryAfterMs: null,
    };
  }
  if (status >= 300 && status < 400) {
    return {
      outcome: 'redirect',
      statusCode: status,
      error: 'The endpoint answered with a redirect, which is not followed. Use the final URL.',
      gone: false,
      retryAfterMs: null,
    };
  }
  return {
    outcome: 'http_error',
    statusCode: status,
    error: `The endpoint answered HTTP ${status}.`,
    gone: status === 410,
    retryAfterMs: retryAfter(response.headers['retry-after'], now),
  };
}

export function judgeError(error: EgressError): Judgement {
  const outcome: AttemptOutcome =
    error.problem === 'timeout'
      ? 'timeout'
      : error.problem === 'tls'
        ? 'tls'
        : error.problem === 'network'
          ? 'network'
          : error.problem === 'unresolvable'
            ? 'unresolvable'
            : 'blocked';
  return { outcome, statusCode: null, error: error.message, gone: false, retryAfterMs: null };
}

/**
 * When to try again after failed attempt `attempt` (1-based), or null when it was the last.
 * Full jitter within ±20% keeps retries from many endpoints from lining up.
 */
export function nextAttemptDelay(
  attempt: number,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  const jittered = Math.round((base as number) * (0.8 + random() * 0.4));
  const asked = retryAfterMs === null ? 0 : Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
  return Math.max(jittered, asked);
}

/** Whether an endpoint has failed long enough, often enough, to be turned off. */
export function shouldDisable(input: {
  consecutiveFailures: number;
  failingSince: Date | null;
  now: Date;
  afterFailures: number;
  afterHours: number;
}): boolean {
  if (input.consecutiveFailures < input.afterFailures || !input.failingSince) return false;
  return input.now.getTime() - input.failingSince.getTime() >= input.afterHours * 3_600_000;
}

const SECRETISH = [
  /whsec_[A-Za-z0-9+/=]+/g,
  /hv_live_[0-9a-z]+_[0-9A-Za-z]+/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]+/g,
  /\bBearer\s+[^\s"']+/gi,
  /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]*/g,
  /\b[0-9A-Fa-f]{32,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}/g,
];

/**
 * The first characters of a response body for the delivery log: printable text only, anything
 * that looks like a key, token or long secret replaced, at most 300 characters.
 */
export function responseExcerpt(body: Buffer): string | null {
  if (body.length === 0) return null;
  let text = body.subarray(0, 1024).toString('utf8');
  text = text
    .replace(/[^\P{C}\n\t]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const pattern of SECRETISH) text = text.replace(pattern, '[redacted]');
  return text.length === 0 ? null : text.slice(0, 300);
}
