import { API_BASE } from './config';
import type { ErrorCode, Problem } from './types';

export type ApiErrorCode = ErrorCode | 'NETWORK' | 'UNKNOWN';

/** A failed API call, carrying the RFC 9457 problem the gateway sent (when it sent one). */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly problem: Problem | null,
  ) {
    super(problem?.detail ?? problem?.title ?? code);
  }

  get requestId(): string | null {
    return this.problem?.requestId ?? null;
  }

  get fields(): { path: string; message: string }[] {
    return this.problem?.fields ?? [];
  }
}

export const isApiError = (error: unknown, ...codes: ApiErrorCode[]): error is ApiError =>
  error instanceof ApiError && (codes.length === 0 || codes.includes(error.code));

/** The session is gone: signing in again fixes it. */
export const isSignedOut = (error: unknown) =>
  isApiError(error, 'AUTH_REQUIRED', 'SESSION_EXPIRED');

const STATUS_CODES: Record<number, ErrorCode> = {
  401: 'AUTH_REQUIRED',
  403: 'SCOPE_DENIED',
  404: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  413: 'UPLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

function problemOf(value: unknown): Problem | null {
  return value !== null && typeof value === 'object' && 'code' in value && 'status' in value
    ? (value as Problem)
    : null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as X-Hamnivo-Tenant (every /v1/admin route needs it). */
  tenant?: string | null;
  /** Makes a retry of the same create safe: the gateway replays the first result. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Calls the gateway with the staff cookie session and turns failures into ApiError. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: string | undefined;
  if (method !== 'GET') {
    // Fastify rejects an empty JSON body, so body-less actions send {}.
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body ?? {});
  }
  if (options.tenant) headers['x-hamnivo-tenant'] = options.tenant;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body,
      credentials: 'include',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', null);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const problem = problemOf(json);
    throw new ApiError(
      response.status,
      problem?.code ??
        STATUS_CODES[response.status] ??
        (response.status >= 500 ? 'INTERNAL' : 'UNKNOWN'),
      problem,
    );
  }
  return json as T;
}

/** RFC 9562 version 4 UUID; crypto.randomUUID is missing on plain-HTTP origins. */
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
