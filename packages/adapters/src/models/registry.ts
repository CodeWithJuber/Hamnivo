import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { EmbeddingModelV4, LanguageModelV4 } from '@ai-sdk/provider';
import { capabilitiesOf, type ModelCapabilities } from './capabilities.js';
import { ModelCapabilityError, ModelConfigError } from './errors.js';
import { createMockModel } from './mock.js';
import { createMockEmbeddingModel } from './mock-embedding.js';

export type ModelProviderKind = 'anthropic' | 'openai' | 'google' | 'openai-compatible' | 'mock';

/** One model of one tenant. The gateway resolves credentials; this package never reads them. */
export interface ModelSpec {
  provider: ModelProviderKind;
  /** The provider's model id, such as `claude-haiku-4-5`, `gpt-5.4-mini` or `gemini-3.8-flash`. */
  modelId: string;
  /** Required for anthropic, openai and google; optional for an OpenAI-compatible server. */
  apiKey?: string;
  /** Required for openai-compatible. The others default to the provider's public API. */
  baseURL?: string;
  /** Extra request headers, for example for a proxy. */
  headers?: Record<string, string>;
  /** Replaces the global fetch, for example with an egress-restricted client. */
  fetch?: typeof globalThis.fetch;
  /** Name of an OpenAI-compatible server (`ollama`, `vllm`); it keys that server's provider options. */
  name?: string;
  /** What this model supports, where it differs from its provider; see `capabilitiesOf`. */
  capabilities?: Partial<ModelCapabilities>;
}

// Passing these explicitly also keeps the SDKs from reading ANTHROPIC_BASE_URL and
// OPENAI_BASE_URL from the environment.
const PUBLIC_BASE_URLS = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

/**
 * Settings for a first-party provider. A missing key fails here: the SDKs would fall back to
 * ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY and bill the tenant's calls
 * to the server's own key.
 */
function firstParty(spec: ModelSpec, provider: keyof typeof PUBLIC_BASE_URLS) {
  if (!spec.apiKey) {
    throw new ModelConfigError('apiKey', `${provider} needs an API key in the model spec`);
  }
  return {
    apiKey: spec.apiKey,
    baseURL: spec.baseURL ?? PUBLIC_BASE_URLS[provider],
    headers: spec.headers,
    fetch: spec.fetch,
  };
}

function compatible(spec: ModelSpec) {
  if (!spec.baseURL) {
    throw new ModelConfigError('baseURL', 'openai-compatible needs a base URL in the model spec');
  }
  return createOpenAICompatible({
    name: spec.name ?? 'openai-compatible',
    baseURL: spec.baseURL,
    apiKey: spec.apiKey,
    headers: spec.headers,
    fetch: spec.fetch,
    // Stream usage feeds cost accounting. Ollama documents stream_options.include_usage.
    includeUsage: true,
    supportsStructuredOutputs: capabilitiesOf(spec).structuredOutput,
  });
}

/** A language model for a spec. OpenAI models use the Chat Completions API. */
export function createLanguageModel(spec: ModelSpec): LanguageModelV4 {
  capabilitiesOf(spec); // rejects a provider from stored settings that this package does not know
  switch (spec.provider) {
    case 'anthropic':
      return createAnthropic(firstParty(spec, 'anthropic')).languageModel(spec.modelId);
    case 'openai':
      return createOpenAI(firstParty(spec, 'openai')).chat(spec.modelId);
    case 'google':
      return createGoogle(firstParty(spec, 'google')).languageModel(spec.modelId);
    case 'openai-compatible':
      return compatible(spec).chatModel(spec.modelId);
    case 'mock':
      return createMockModel({ modelId: spec.modelId });
  }
}

/**
 * A text embedding model for a spec. Throws `ModelCapabilityError` for a provider without
 * embeddings (Anthropic) or a model declared without them.
 */
export function createEmbeddingModel(spec: ModelSpec): EmbeddingModelV4 {
  if (!capabilitiesOf(spec).embeddings) {
    throw new ModelCapabilityError(spec.provider, 'embeddings');
  }
  switch (spec.provider) {
    case 'openai':
      return createOpenAI(firstParty(spec, 'openai')).embeddingModel(spec.modelId);
    case 'google':
      return createGoogle(firstParty(spec, 'google')).embeddingModel(spec.modelId);
    case 'openai-compatible':
      return compatible(spec).embeddingModel(spec.modelId);
    case 'mock':
      return createMockEmbeddingModel({ modelId: spec.modelId });
    case 'anthropic':
      throw new ModelCapabilityError(spec.provider, 'embeddings');
  }
}
