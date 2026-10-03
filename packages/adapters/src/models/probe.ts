import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { ModelConfigError, normalizeModelError } from './errors.js';
import { createLanguageModel, type ModelSpec } from './registry.js';

/** What one test call found out about a key and a model. */
export type ProbeKind =
  | 'ok'
  | 'wrong_key'
  | 'no_credit'
  | 'model_not_found'
  | 'network'
  | 'blocked'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

export interface ProbeResult {
  ok: boolean;
  kind: ProbeKind;
  latencyMs: number;
  /** The provider's HTTP status, when it answered. */
  status?: number;
}

/** A few words are enough to learn whether a key and a model are accepted. */
export const PROBE_MAX_OUTPUT_TOKENS = 16;
export const PROBE_TIMEOUT_MS = 10_000;

const PROBE_PROMPT: LanguageModelV4Prompt = [
  { role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] },
];

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;

// OpenAI sends these with a 429, Anthropic with a 400 or 402; waiting does not bring credit back.
const CREDIT_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'billing_error',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);
// The provider's own words, read to classify and never passed on. The soft wording is what Gemini
// says both for a drained account and for a per-minute limit; it counts as no credit only when the
// provider does not also say when to try again.
const CREDIT_TEXT =
  /credit balance|insufficient (?:funds|credit|quota|balance)|out of credit|billing (?:hard )?limit|spend limit|purchase credits|payment required|add a payment method|billing is not (?:active|enabled)/i;
const SOFT_CREDIT_TEXT = /exceeded your current quota|billing (?:account|details)/i;
const MODEL_CODES = new Set(['model_not_found', 'not_found_error', 'NOT_FOUND']);
const MODEL_TEXT =
  /model[^.]{0,80}(?:not found|does not exist|is not supported|is not available|unknown|invalid)|(?:not found|no such|unknown|invalid) model|does not have access to (?:the )?model|is not found for api version/i;

/** Where a refused address or a failed connection started: the egress guard names its refusals. */
const BLOCKED_PROBLEMS = new Set([
  'invalid_url',
  'insecure_url',
  'host_not_allowed',
  'private_address',
  'redirect',
]);

/**
 * The egress guard's refusal behind a failed call, found along the cause chain. It is recognised
 * by name, so this entry point stays free of the guard's Node-only code.
 */
function egressProblem(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; isRecord(current) && depth < 8; depth += 1) {
    if (current.name === 'EgressError' && typeof current.problem === 'string') {
      return current.problem;
    }
    current = current.cause;
  }
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

interface Said {
  status: number | undefined;
  codes: Set<string>;
  text: string;
  /** The provider said how long to wait: a limit that passes, not an empty account. */
  retryHint: boolean;
}

/** The status, error codes and message of a provider's answer, for classifying only. */
function providerSays(error: unknown): Said {
  const said: Said = { status: undefined, codes: new Set(), text: '', retryHint: false };
  let inner = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!isRecord(inner) || inner.name !== 'AI_RetryError' || !('lastError' in inner)) break;
    inner = inner.lastError;
  }
  if (!isRecord(inner)) return said;
  if (typeof inner.statusCode === 'number') said.status = inner.statusCode;
  const add = (value: unknown) => {
    if (typeof value === 'string' && value !== '') said.codes.add(value);
  };
  add(inner.code);
  add(inner.type);
  const body = isRecord(inner.data) ? inner.data : parseJson(inner.responseBody);
  if (isRecord(body)) {
    const envelope = isRecord(body.error) ? body.error : body;
    add(envelope.code);
    add(envelope.type);
    add(envelope.status);
    if (typeof envelope.message === 'string') said.text = envelope.message;
    if (Array.isArray(envelope.details)) {
      for (const detail of envelope.details) {
        if (!isRecord(detail)) continue;
        add(detail.reason);
        if (typeof detail.retryDelay === 'string') said.retryHint = true;
      }
    }
  }
  if (!said.text && typeof inner.message === 'string') said.text = inner.message;
  return said;
}

/**
 * Sorts a failed test call into what a person can act on. The key is wrong, the account has no
 * credit, the model name is not known, the provider cannot be reached, or the server address is
 * refused; anything else is the provider's own trouble. Credit is checked before the key because
 * providers answer a drained account with a 402 or a billing error that look like a refusal.
 */
export function classifyProbeError(error: unknown): ProbeKind {
  const blocked = egressProblem(error);
  if (blocked) return BLOCKED_PROBLEMS.has(blocked) ? 'blocked' : 'network';
  if (isRecord(error) && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'network';
  }
  if (error instanceof ModelConfigError) return error.field === 'apiKey' ? 'wrong_key' : 'unknown';

  const said = providerSays(error);
  const has = (codes: Set<string>) => [...said.codes].some((code) => codes.has(code));
  if (
    said.status === 402 ||
    has(CREDIT_CODES) ||
    CREDIT_TEXT.test(said.text) ||
    (SOFT_CREDIT_TEXT.test(said.text) && !said.retryHint)
  ) {
    return 'no_credit';
  }

  const normalized = normalizeModelError(error);
  if (said.status === 401 || said.status === 403 || normalized.kind === 'auth') return 'wrong_key';
  if (said.status === 404 || has(MODEL_CODES) || MODEL_TEXT.test(said.text)) {
    return 'model_not_found';
  }
  switch (normalized.kind) {
    case 'rate_limited':
      return 'rate_limited';
    case 'overloaded':
      return 'unavailable';
    case 'unavailable':
    case 'timeout':
      // No answer at all is a network problem; an answer with a 5xx is the provider's.
      return normalized.status === undefined ? 'network' : 'unavailable';
    default:
      return 'unknown';
  }
}

export interface ProbeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One real call of a few tokens with the spec's key and model, to learn whether they work. It
 * never throws and never returns the provider's text: only a kind a person can act on. The call
 * is made once, without the retries a customer's reply would get, and gives up after ten seconds.
 * Pass the spec a `fetch` from the egress guard so the address is checked on every connection.
 */
export async function probeModel(
  spec: ModelSpec,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const deadline = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const model = createLanguageModel(spec);
    await model.doGenerate({
      prompt: PROBE_PROMPT,
      maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
      abortSignal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    });
    return { ok: true, kind: 'ok', latencyMs: elapsed() };
  } catch (error) {
    const status = providerSays(error).status;
    return {
      ok: false,
      kind: classifyProbeError(error),
      latencyMs: elapsed(),
      ...(status === undefined ? {} : { status }),
    };
  }
}
