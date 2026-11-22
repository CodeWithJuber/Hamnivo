import { APICallError } from '@ai-sdk/provider';
import { classifyProbeError, PROBE_TIMEOUT_MS, type ProbeKind } from './probe.js';
import type { ModelProviderKind, ModelSpec } from './registry.js';

/** One model a key can call, as the provider names it. */
export interface ListedModel {
  /** The id agents and the provider use, such as `claude-haiku-5-5`. */
  id: string;
  /** The provider's own friendly name, such as "Claude Haiku 5.5", when it gives one. */
  name: string | null;
  /** The provider says it is on its way out: still callable, closed to new users. */
  deprecated: boolean;
}

/** Why a list could not be read. A model name cannot be wrong here, so that kind never comes. */
export type ListModelsProblem = Exclude<ProbeKind, 'ok' | 'model_not_found'>;

export type ListModelsResult =
  | { ok: true; models: ListedModel[] }
  | { ok: false; kind: ListModelsProblem; status?: number };

/** What a list needs: where the provider is and the key. No model is named. */
export type ListSpec = Omit<ModelSpec, 'modelId' | 'capabilities' | 'name' | 'provider'> & {
  provider: Exclude<ModelProviderKind, 'mock'>;
};

export interface ListModelsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** More than any provider offers today; a server that sends more is cut off here. */
export const LIST_MAX_MODELS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const PUBLIC_BASE_URLS = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

/**
 * Model families that do not answer a chat: embeddings, speech, pictures, video, moderation, live
 * audio, the old completion models, and models that only work through OpenAI's Responses API
 * (Hamnivo calls Chat Completions). Providers do not mark chat models, so this goes by name; a
 * model it hides can still be typed in.
 */
const NOT_CHAT =
  /(?:^|[-_.:/])(?:embed|embedding|embeddings|tts|whisper|transcribe|dall-e|image|imagen|moderation|realtime|audio|sora|veo|davinci|babbage|rerank|codex|computer-use|deep-research)(?=$|[-_.:/\d])/i;

const isChat = (id: string) => !NOT_CHAT.test(id);

type UnknownRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null;
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const trim = (url: string) => url.replace(/\/+$/, '');

/** The request for each provider: its own address, header for the key, and query. */
function requestFor(spec: ListSpec): { url: string; headers: Record<string, string> } | null {
  const headers: Record<string, string> = { accept: 'application/json', ...spec.headers };
  switch (spec.provider) {
    case 'anthropic': {
      if (!spec.apiKey) return null;
      // https://platform.claude.com/docs/en/api/models/list; up to 1000 per page.
      headers['x-api-key'] = spec.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      return {
        url: `${trim(spec.baseURL ?? PUBLIC_BASE_URLS.anthropic)}/models?limit=1000`,
        headers,
      };
    }
    case 'openai': {
      if (!spec.apiKey) return null;
      // https://platform.openai.com/docs/api-reference/models/list; one page, no paging.
      headers.authorization = `Bearer ${spec.apiKey}`;
      return { url: `${trim(spec.baseURL ?? PUBLIC_BASE_URLS.openai)}/models`, headers };
    }
    case 'google': {
      if (!spec.apiKey) return null;
      // https://ai.google.dev/api/models#method:-models.list; the key goes in a header, never in
      // the address, where proxies and access logs would keep it.
      headers['x-goog-api-key'] = spec.apiKey;
      return {
        url: `${trim(spec.baseURL ?? PUBLIC_BASE_URLS.google)}/models?pageSize=1000`,
        headers,
      };
    }
    case 'openai-compatible': {
      if (!spec.baseURL) return null;
      // Ollama, vLLM and LM Studio answer GET /models in OpenAI's shape.
      if (spec.apiKey) headers.authorization = `Bearer ${spec.apiKey}`;
      return { url: `${trim(spec.baseURL)}/models`, headers };
    }
  }
}

/** Reads each provider's answer into one shape, keeping chat models only. */
function modelsOf(provider: ListSpec['provider'], body: unknown): ListedModel[] | null {
  if (!isRecord(body)) return null;
  const rows = provider === 'google' ? body.models : body.data;
  if (!Array.isArray(rows)) return null;
  const models: (ListedModel & { created: number })[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (provider === 'google') {
      const methods = Array.isArray(row.supportedGenerationMethods)
        ? row.supportedGenerationMethods
        : [];
      const id = text(row.name)?.replace(/^models\//, '');
      if (!id || !methods.includes('generateContent') || !isChat(id)) continue;
      models.push({ id, name: text(row.displayName), deprecated: false, created: 0 });
      continue;
    }
    const id = text(row.id);
    if (!id) continue;
    if (provider === 'anthropic') {
      // Retired models are left out unless asked for; deprecated ones still answer.
      if (row.lifecycle === 'retired') continue;
      models.push({
        id,
        name: text(row.display_name),
        deprecated: row.lifecycle === 'deprecated',
        created: 0,
      });
      continue;
    }
    if (!isChat(id)) continue;
    models.push({
      id,
      name: null,
      deprecated: false,
      created: typeof row.created === 'number' ? row.created : 0,
    });
  }
  // Anthropic and Google send their own order (Anthropic newest first). OpenAI's list has no
  // order, so its newest come first; a server of your own is sorted by name.
  if (provider === 'openai') {
    models.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
  }
  if (provider === 'openai-compatible') models.sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const listed: ListedModel[] = [];
  for (const { created: _created, ...model } of models) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    listed.push(model);
  }
  // Models on their way out go last, so the first entries are the ones to choose.
  listed.sort((a, b) => Number(a.deprecated) - Number(b.deprecated));
  return listed.slice(0, LIST_MAX_MODELS);
}

/** A refusal classified the same way as a test call, so the same plain words fit. */
function problemOf(error: unknown, answered: boolean): ListModelsProblem {
  const kind = classifyProbeError(error);
  if (kind === 'ok') return 'unknown';
  // A 404 here means the server has no model list, not that a model is wrong.
  if (kind === 'model_not_found') return 'unknown';
  // Without an answer the provider was not reached at all.
  if (!answered && kind === 'unknown') return 'network';
  return kind;
}

/**
 * The chat models a key can use, read from the provider's own list. It never throws and never
 * returns the provider's text. One request, no retries, and it gives up after ten seconds. Pass a
 * `fetch` from the egress guard when the address or the key comes from a tenant.
 */
export async function listModels(
  spec: ListSpec,
  options: ListModelsOptions = {},
): Promise<ListModelsResult> {
  const request = requestFor(spec);
  if (!request) {
    return { ok: false, kind: spec.provider === 'openai-compatible' ? 'blocked' : 'wrong_key' };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const fetcher = spec.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(request.url, { method: 'GET', headers: request.headers, signal });
  } catch (error) {
    return { ok: false, kind: problemOf(error, false) };
  }
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return { ok: false, kind: problemOf(error, false), status: response.status };
  }
  if (!response.ok) {
    const error = new APICallError({
      message: `The model list was refused (${response.status})`,
      url: request.url,
      requestBodyValues: {},
      statusCode: response.status,
      responseHeaders: Object.fromEntries(response.headers),
      responseBody: body.slice(0, 64 * 1024),
    });
    return { ok: false, kind: problemOf(error, true), status: response.status };
  }
  if (body.length > MAX_BODY_BYTES) return { ok: false, kind: 'unknown', status: response.status };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, kind: 'unknown', status: response.status };
  }
  const models = modelsOf(spec.provider, parsed);
  return models ? { ok: true, models } : { ok: false, kind: 'unknown', status: response.status };
}
