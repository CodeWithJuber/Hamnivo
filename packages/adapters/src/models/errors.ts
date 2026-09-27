import { APICallError } from '@ai-sdk/provider';
import type { ModelCapability } from './capabilities.js';

export type ModelErrorKind =
  | 'auth'
  | 'rate_limited'
  | 'overloaded'
  | 'unavailable'
  | 'timeout'
  | 'aborted'
  | 'invalid_request'
  | 'content_filtered'
  | 'context_length'
  | 'unknown';

/** A provider failure in one shape, safe to log and to show to staff. */
export interface NormalizedModelError {
  kind: ModelErrorKind;
  /** The same call may succeed if repeated later. */
  retryable: boolean;
  /** How long the provider asked callers to wait, when it said. */
  retryAfterMs?: number;
  /** HTTP status, when the provider answered. */
  status?: number;
  provider?: string;
  /** Built from the kind, provider, status and error code only; never keys or prompt text. */
  message: string;
}

/** The spec asks a provider for something it does not offer, such as Anthropic embeddings. */
export class ModelCapabilityError extends Error {
  override name = 'ModelCapabilityError';
  constructor(
    readonly provider: string,
    readonly capability: ModelCapability,
  ) {
    super(`${provider} models do not support ${capability}`);
  }
}

/** The spec is incomplete: no API key, no base URL, or a provider this adapter does not know. */
export class ModelConfigError extends Error {
  override name = 'ModelConfigError';
  constructor(
    readonly field: 'apiKey' | 'baseURL' | 'provider',
    message: string,
  ) {
    super(message);
  }
}

const LABELS: Record<ModelErrorKind, string> = {
  auth: 'The provider rejected the credentials or the account',
  rate_limited: 'The provider rate limited the request',
  overloaded: 'The provider is overloaded',
  unavailable: 'The provider is unavailable',
  timeout: 'The model call timed out',
  aborted: 'The model call was aborted',
  invalid_request: 'The provider rejected the request',
  content_filtered: 'A content filter blocked the request',
  context_length: 'The prompt is too long for the model',
  unknown: 'The model call failed',
};

const RETRYABLE_KINDS: ReadonlySet<ModelErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'unavailable',
  'timeout',
]);

// OpenAI sends these with a 429, but waiting does not help: "Retrying billing, spend, or quota
// errors won't restore API access" (https://developers.openai.com/api/docs/guides/error-codes).
const EXHAUSTED_CODES = [
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
];

const AUTH_CODES = [
  'authentication_error',
  'permission_error',
  'billing_error',
  'invalid_api_key',
  // Gemini answers a bad key with 400 INVALID_ARGUMENT and this ErrorInfo reason.
  'API_KEY_INVALID',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
];
const CONTEXT_CODES = ['context_length_exceeded', 'request_too_large'];
const CONTENT_CODES = ['content_filter', 'content_policy_violation'];
const RATE_CODES = [
  'rate_limit_error',
  'rate_limit_exceeded',
  'RESOURCE_EXHAUSTED',
  ...EXHAUSTED_CODES,
];
const OVERLOAD_CODES = ['overloaded_error', 'server_is_overloaded'];
const TIMEOUT_CODES = ['timeout_error', 'DEADLINE_EXCEEDED'];
const UNAVAILABLE_CODES = [
  'api_error',
  'server_error',
  'service_unavailable_error',
  'INTERNAL',
  'UNAVAILABLE',
];
const INVALID_CODES = ['invalid_request_error', 'not_found_error', 'INVALID_ARGUMENT', 'NOT_FOUND'];
const INVALID_NAMES = [
  'AI_InvalidArgumentError',
  'AI_InvalidPromptError',
  'AI_NoSuchModelError',
  'AI_TooManyEmbeddingValuesForCallError',
  'AI_UnsupportedFunctionalityError',
];

// Provider messages are matched here to classify, and never copied into the result.
const CONTEXT_TEXT =
  /context length|context window|maximum context|prompt is too long|too many tokens|input token count|exceeds the maximum number of tokens/i;
const CONTENT_TEXT = /content management policy|content policy|content[ _]filter|safety system/i;

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);
const NETWORK_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const FETCH_FAILED = /^(fetch failed|failed to fetch|terminated)$/i;

// Letters and underscores only, so a key or a fragment of text cannot pass as a code.
const SAFE_CODE = /^[A-Za-z][A-Za-z_]{1,63}$/;
const GENERIC_NAMES = new Set(['Error', 'TypeError', 'AI_APICallError']);

const HOSTS: Record<string, string> = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'generativelanguage.googleapis.com': 'google',
};

interface Facts {
  name?: string;
  status?: number;
  url?: string;
  headers: Record<string, string>;
  /** Provider error identifiers: error types and codes, Google statuses and ErrorInfo reasons. */
  codes: Set<string>;
  /** The provider's own message, for classification only. */
  text: string;
  /** Google RetryInfo.retryDelay. */
  retryDelayMs?: number;
  network?: { code?: string; timeout: boolean };
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

/**
 * Maps any failure from a model call (AI SDK errors, provider stream errors, fetch and abort
 * errors) to one shape. `context.provider` names the provider when the error does not (an
 * OpenAI-compatible server, for example); an SDK provider id such as `anthropic.messages` works.
 */
export function normalizeModelError(
  error: unknown,
  context: { provider?: string } = {},
): NormalizedModelError {
  const inner = unwrapRetries(error);
  const facts = factsOf(inner);
  const kind = kindOf(inner, facts);
  const retryable = RETRYABLE_KINDS.has(kind) && !hasAny(facts, EXHAUSTED_CODES);
  const provider = context.provider?.split('.')[0] || providerFromUrl(facts.url);
  const result: NormalizedModelError = { kind, retryable, message: '' };
  if (retryable) {
    const retryAfterMs = retryAfterMsOf(facts);
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  }
  if (facts.status !== undefined) result.status = facts.status;
  if (provider) result.provider = provider;
  result.message = messageOf(inner, kind, facts, provider);
  return result;
}

/** The AI SDK wraps the last attempt's error after its own retries. */
function unwrapRetries(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!isRecord(current) || current.name !== 'AI_RetryError' || !('lastError' in current)) break;
    current = current.lastError;
  }
  return current;
}

function factsOf(error: unknown): Facts {
  const facts: Facts = { headers: {}, codes: new Set(), text: '' };
  if (!isRecord(error)) return facts;
  if (typeof error.name === 'string') facts.name = error.name;
  const status = typeof error.statusCode === 'number' ? error.statusCode : error.status;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600) {
    facts.status = status;
  }
  if (typeof error.url === 'string') facts.url = error.url;
  if (isRecord(error.responseHeaders)) {
    for (const [key, value] of Object.entries(error.responseHeaders)) {
      if (typeof value === 'string') facts.headers[key.toLowerCase()] = value;
    }
  }
  // Provider stream errors carry the provider's fields on the error itself.
  addCode(facts, error.code);
  addCode(facts, error.type);
  if (typeof error.message === 'string') facts.text = error.message;
  readEnvelope(facts, isRecord(error.data) ? error.data : parseJson(error.responseBody));
  facts.network = networkOf(error);
  return facts;
}

/** Reads `{ error: { type, code, status, message, details } }` and flat variants of it. */
function readEnvelope(facts: Facts, body: unknown) {
  if (!isRecord(body)) return;
  const envelope = isRecord(body.error) ? body.error : body;
  addCode(facts, envelope.code);
  addCode(facts, envelope.type);
  addCode(facts, envelope.status);
  if (typeof envelope.message === 'string') facts.text = envelope.message;
  if (!Array.isArray(envelope.details)) return;
  for (const detail of envelope.details) {
    if (!isRecord(detail)) continue;
    addCode(facts, detail.reason);
    const delay =
      typeof detail.retryDelay === 'string' && /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay);
    if (delay) facts.retryDelayMs = Math.round(Number(delay[1]) * 1000);
  }
}

function networkOf(error: UnknownRecord): Facts['network'] {
  let failed = false;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && isRecord(current); depth++, current = current.cause) {
    const code = current.code;
    if (typeof code === 'string' && (NETWORK_CODES.has(code) || NETWORK_TIMEOUT_CODES.has(code))) {
      return { code, timeout: NETWORK_TIMEOUT_CODES.has(code) };
    }
    if (current.name === 'TypeError' && FETCH_FAILED.test(String(current.message))) failed = true;
    // The SDK only builds an APICallError without a status when the request never got an answer.
    if (APICallError.isInstance(current) && current.statusCode === undefined) failed = true;
  }
  return failed ? { timeout: false } : undefined;
}

function kindOf(error: unknown, facts: Facts): ModelErrorKind {
  const { name, status, text } = facts;
  if (name === 'AbortError' || name === 'ResponseAborted') return 'aborted';
  if (name === 'TimeoutError') return 'timeout';
  if (error instanceof ModelCapabilityError) return 'invalid_request';
  if (error instanceof ModelConfigError)
    return error.field === 'apiKey' ? 'auth' : 'invalid_request';
  if (name === 'AI_LoadAPIKeyError') return 'auth';
  if (facts.network && status === undefined)
    return facts.network.timeout ? 'timeout' : 'unavailable';

  if (status === 401 || status === 402 || status === 403 || hasAny(facts, AUTH_CODES))
    return 'auth';
  if (status === 413 || hasAny(facts, CONTEXT_CODES) || (status === 400 && CONTEXT_TEXT.test(text)))
    return 'context_length';
  if (hasAny(facts, CONTENT_CODES) || (status === 400 && CONTENT_TEXT.test(text)))
    return 'content_filtered';
  if (status === 429 || hasAny(facts, RATE_CODES)) return 'rate_limited';
  // Anthropic uses 529; OpenAI and Gemini report overload as a 503.
  if (
    status === 529 ||
    hasAny(facts, OVERLOAD_CODES) ||
    (status === 503 && /overloaded/i.test(text))
  )
    return 'overloaded';
  if (status === 408 || status === 504 || hasAny(facts, TIMEOUT_CODES)) return 'timeout';
  if ((status !== undefined && status >= 500) || hasAny(facts, UNAVAILABLE_CODES))
    return 'unavailable';
  if (
    (status !== undefined && status >= 400) ||
    hasAny(facts, INVALID_CODES) ||
    (name !== undefined && INVALID_NAMES.includes(name))
  )
    return 'invalid_request';
  return 'unknown';
}

function retryAfterMsOf(facts: Facts): number | undefined {
  const ms = Number.parseFloat(facts.headers['retry-after-ms'] ?? '');
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const after = facts.headers['retry-after']?.trim();
  if (after) {
    const seconds = Number(after);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return facts.retryDelayMs;
}

function messageOf(
  error: unknown,
  kind: ModelErrorKind,
  facts: Facts,
  provider: string | undefined,
): string {
  // Built by this package from spec field names, so they are safe to pass on.
  if (error instanceof ModelCapabilityError || error instanceof ModelConfigError) {
    return error.message;
  }
  // A specific error class (AI_TypeValidationError) helps when the provider gave no code.
  const named =
    (kind === 'unknown' || kind === 'invalid_request') && !GENERIC_NAMES.has(facts.name ?? '')
      ? facts.name
      : undefined;
  const code = [facts.network?.code, ...facts.codes, named].find(
    (value) => value !== undefined && SAFE_CODE.test(value),
  );
  const detail = [provider, facts.status === undefined ? undefined : `HTTP ${facts.status}`, code]
    .filter(Boolean)
    .join(', ');
  return detail ? `${LABELS[kind]} (${detail})` : LABELS[kind];
}

function addCode(facts: Facts, value: unknown) {
  if (typeof value === 'string' && value !== '') facts.codes.add(value);
}

function hasAny(facts: Facts, codes: readonly string[]): boolean {
  return codes.some((code) => facts.codes.has(code));
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function providerFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return HOSTS[new URL(url).hostname];
  } catch {
    return undefined;
  }
}
