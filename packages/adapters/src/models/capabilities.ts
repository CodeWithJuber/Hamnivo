import { ModelConfigError } from './errors.js';
import type { ModelProviderKind, ModelSpec } from './registry.js';

/** What a provider can do through this adapter. */
export interface ModelCapabilities {
  /** Output arrives token by token (`doStream`). */
  streaming: boolean;
  /** The model can call tools (functions) the caller defines. */
  toolCalls: boolean;
  /** The output can be constrained to a JSON schema. */
  structuredOutput: boolean;
  /** The provider has a text embedding endpoint. */
  embeddings: boolean;
  /** User messages can include images. */
  imageInput: boolean;
}

export type ModelCapability = keyof ModelCapabilities;

/**
 * Checked against each provider's documentation. A single model can still lack a feature its
 * provider offers; narrow it with `ModelSpec.capabilities`.
 */
export const PROVIDER_CAPABILITIES: Readonly<
  Record<ModelProviderKind, Readonly<ModelCapabilities>>
> = Object.freeze({
  anthropic: Object.freeze({
    // https://platform.claude.com/docs/en/build-with-claude/streaming
    streaming: true,
    // https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
    toolCalls: true,
    // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
    structuredOutput: true,
    // "Anthropic does not offer its own embedding model":
    // https://platform.claude.com/docs/en/build-with-claude/embeddings
    embeddings: false,
    // https://platform.claude.com/docs/en/build-with-claude/vision
    imageInput: true,
  }),
  openai: Object.freeze({
    // `stream` and `stream_options.include_usage`:
    // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
    streaming: true,
    // https://developers.openai.com/api/docs/guides/function-calling
    toolCalls: true,
    // https://developers.openai.com/api/docs/guides/structured-outputs
    structuredOutput: true,
    // https://developers.openai.com/api/docs/guides/embeddings
    embeddings: true,
    // https://developers.openai.com/api/docs/guides/images-vision
    imageInput: true,
  }),
  google: Object.freeze({
    // `models.streamGenerateContent`: https://ai.google.dev/api/generate-content
    streaming: true,
    // https://ai.google.dev/gemini-api/docs/function-calling
    toolCalls: true,
    // https://ai.google.dev/gemini-api/docs/structured-output
    structuredOutput: true,
    // https://ai.google.dev/gemini-api/docs/embeddings
    embeddings: true,
    // https://ai.google.dev/gemini-api/docs/image-understanding
    imageInput: true,
  }),
  // The protocol is OpenAI's, but each server implements its own subset (Ollama lists its
  // own: https://docs.ollama.com/api/openai-compatibility). Only the two endpoints the adapter
  // always calls are claimed; declare the rest per server in `ModelSpec.capabilities`.
  'openai-compatible': Object.freeze({
    // https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
    streaming: true,
    toolCalls: false,
    structuredOutput: false,
    // https://developers.openai.com/api/reference/resources/embeddings/methods/create
    embeddings: true,
    imageInput: false,
  }),
  // What mock.ts and mock-embedding.ts implement.
  mock: Object.freeze({
    streaming: true,
    toolCalls: false,
    structuredOutput: false,
    embeddings: true,
    imageInput: false,
  }),
});

/**
 * Capabilities of the model a spec describes. `spec.capabilities` can switch a capability off for
 * any provider, but only an OpenAI-compatible server can claim more than the table above.
 */
export function capabilitiesOf(
  spec: Pick<ModelSpec, 'provider' | 'capabilities'>,
): ModelCapabilities {
  // Specs come from stored tenant settings, so the provider is checked at run time too.
  if (!Object.hasOwn(PROVIDER_CAPABILITIES, spec.provider)) {
    throw new ModelConfigError('provider', 'Unknown model provider');
  }
  const base = PROVIDER_CAPABILITIES[spec.provider];
  const result = { ...base };
  for (const [key, value] of Object.entries(spec.capabilities ?? {})) {
    if (!(key in base) || typeof value !== 'boolean') continue;
    if (!value || spec.provider === 'openai-compatible') result[key as ModelCapability] = value;
  }
  return result;
}
