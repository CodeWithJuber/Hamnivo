# @hamnivo/adapters

Provider adapters behind shared contracts. Each area has its own entry point and section below.

## Models

`@hamnivo/adapters/models` turns a tenant's model settings into AI SDK 7 models
(`LanguageModelV4` and `EmbeddingModelV4`). It supports Anthropic, OpenAI, Google Gemini, any
OpenAI-compatible server, and offline mocks.

| Export | What it does |
|---|---|
| `createLanguageModel(spec)` | A language model for a `ModelSpec`. OpenAI models use the Chat Completions API. |
| `createEmbeddingModel(spec)` | An embedding model for openai, google, openai-compatible and mock. Anthropic has no embeddings API, so it throws `ModelCapabilityError`. |
| `capabilitiesOf(spec)` | Streaming, tool calls, structured output, embeddings and image input. `capabilities.ts` cites a provider doc for each claim. |
| `normalizeModelError(error)` | Any failure of a model call as `{ kind, retryable, retryAfterMs?, status?, provider?, message }`. |
| `withFallback(models, options?)` | One model that moves to the next model on rate limits, overload, outages and timeouts. |
| `createMockModel()` | `hamnivo-mock`, the offline language model for tenants without a key. |
| `createMockEmbeddingModel({ dimensions })` | Offline embeddings: hashed words in a unit vector, 768 values by default. |

### The spec

| Field | Notes |
|---|---|
| `provider` | `anthropic`, `openai`, `google`, `openai-compatible` or `mock`. |
| `modelId` | The provider's id, such as `claude-haiku-4-5`, `gpt-5.4-mini` or `gemini-3.8-flash`. |
| `apiKey` | Required for anthropic, openai and google. Optional for an OpenAI-compatible server. |
| `baseURL` | Required for openai-compatible. The others default to the provider's public API. |
| `headers`, `fetch` | Passed to the provider SDK, for example for a proxy or an egress-restricted client. |
| `name` | The name of an OpenAI-compatible server, such as `ollama`. It keys that server's provider options. |
| `capabilities` | Where one model differs from its provider; see below. |

### Use from the gateway

The gateway resolves each tenant's credentials and passes them in the spec. This package never
reads `process.env`, and it keeps the provider SDKs from reading it too:

- A first-party spec without `apiKey` throws `ModelConfigError`. The SDK would otherwise use
  `ANTHROPIC_API_KEY` or a similar variable, and bill one tenant's calls to the platform's key.
- The base URL is always passed, so `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` are ignored.

```ts
import { createLanguageModel, normalizeModelError, withFallback } from '@hamnivo/adapters/models';
import { generateText } from 'ai';

const model = withFallback(
  [
    createLanguageModel({ provider: 'anthropic', modelId: 'claude-haiku-4-5', apiKey: anthropicKey }),
    createLanguageModel({ provider: 'openai', modelId: 'gpt-5.4-mini', apiKey: openaiKey }),
  ],
  { onFallback: ({ from, to, error }) => logger.warn({ from, to, kind: error.kind }, 'model fallback') },
);

try {
  const result = await generateText({ model, system, messages, abortSignal: AbortSignal.timeout(30_000) });
  const servedBy = result.providerMetadata?.hamnivo?.servedBy; // 'openai.chat/gpt-5.4-mini'
} catch (error) {
  const failure = normalizeModelError(error, { provider: 'anthropic' });
  // Safe to log and to show to staff: no key and no prompt text.
}
```

- Chain only models that have what the task needs. Check with `capabilitiesOf`; `withFallback`
  does not.
- Pass the tenant's own base URL for a regional endpoint or a proxy.

### Errors

| `kind` | Retryable | Falls back | Typical cause |
|---|---|---|---|
| `auth` | no | no | 401, 403, Anthropic 402 billing, Gemini `API_KEY_INVALID`, a missing key |
| `rate_limited` | yes, except OpenAI spend, credit and quota codes | yes | 429, Gemini `RESOURCE_EXHAUSTED` |
| `overloaded` | yes | yes | Anthropic 529, OpenAI and Gemini 503 "overloaded" |
| `unavailable` | yes | yes | Other 5xx, `TypeError: fetch failed`, refused or reset connections |
| `timeout` | yes | yes | 408, 504, connect and header timeouts, `TimeoutError` |
| `aborted` | no | no | The caller aborted |
| `invalid_request` | no | no | Other 4xx, `ModelCapabilityError` |
| `content_filtered` | no | no | A provider content filter |
| `context_length` | no | no | The prompt is over the model's limit, 413 |
| `unknown` | no | no | Anything else |

- `retryAfterMs` comes from `retry-after-ms`, then `retry-after` (seconds or a date), then
  Gemini's `RetryInfo.retryDelay`.
- `message` is built from the kind, provider, status and the provider's error code, for example
  `The provider is overloaded (anthropic, HTTP 529, overloaded_error)`. The provider's own
  message is only read to classify, because it can echo a masked key or parts of the prompt.

### Fallback

- A call moves to the next model only for `rate_limited`, `overloaded`, `unavailable` and
  `timeout`, and never once the caller's abort signal has fired.
- A stream moves on only while it has emitted no content. Parts before the first content are held
  back until content arrives. After that, an error reaches the caller unchanged.
- The serving model is in `providerMetadata.hamnivo.servedBy` (`provider/modelId`), with
  `attempts`. For streams it is on the finish part.
- The AI SDK's `maxRetries` retries the whole chain.

### OpenAI-compatible servers

Servers implement different parts of the OpenAI API, so the table claims only streaming and
embeddings for them. Declare the rest per server:

```ts
createLanguageModel({
  provider: 'openai-compatible',
  name: 'ollama',
  baseURL: 'http://ollama.internal:11434/v1',
  modelId: 'qwen3:8b',
  capabilities: { toolCalls: true, structuredOutput: true },
});
```

A declared `structuredOutput` makes the adapter send JSON-schema response formats. A declaration
can switch a capability off for any provider, but only an OpenAI-compatible server can claim more
than the table. Streams ask the server for usage (`stream_options.include_usage`).

### Tests

```bash
pnpm --filter @hamnivo/adapters test
```

msw answers every request, so no test reaches a provider. The wire fixtures in
`test/models/fixtures/<provider>/` are hand-written from each provider's public API docs; the
kits in `test/models/kits.ts` link the pages.

- **Shared contract** (`contract.ts`, run by `contract.test.ts` against anthropic, openai, google
  and openai-compatible):
  - generate parses text, usage and the finish reason;
  - a stream yields text deltas in order and ends with a finish part, also through `streamText`;
  - the system prompt and turns go out in the provider's format: Anthropic's top-level `system`,
    OpenAI's `developer` message for GPT-5 models, Gemini's `systemInstruction` and `contents`,
    and the chat roles of an OpenAI-compatible server;
  - the key travels in `x-api-key`, `Authorization: Bearer` or `x-goog-api-key`, never in the
    URL or the body;
  - in both modes: 401 is `auth`, 429 with `retry-after` is `rate_limited` with `retryAfterMs`,
    500, 503 and 529 are retryable, and an abort is `aborted`.
- **Per provider:** embeddings for openai, google (`embedContent`, `batchEmbedContents`) and
  openai-compatible; Anthropic embeddings throw `ModelCapabilityError`; Anthropic overload at the
  start of a stream and after text; Gemini `API_KEY_INVALID`, `RetryInfo` and
  `DEADLINE_EXCEEDED`; OpenAI quota codes; OpenAI-compatible servers without a key.
- **Fallback:** a 529 from the primary is served by the secondary (generate and stream); an auth
  error does not fall back; an error after partial stream output surfaces and does not fall back;
  aborts and non-retryable kinds never fall back.
- **Registry:** provider environment variables are ignored; unknown providers are rejected.
- **Mock embeddings:** the same text gives the same unit vector, and retrieval ranks the right
  document in English, Arabic, Urdu and Hindi.

### Limits

- Default tests make no live provider calls. The fixtures follow the providers' docs, not
  recorded traffic, so behavior the docs do not show is not covered.
- `test/models/live.test.ts` makes one tiny call per provider, only with `HAMNIVO_LIVE_MODELS=1`
  and that provider's settings: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`, or `OPENAI_COMPATIBLE_BASE_URL` with `OPENAI_COMPATIBLE_MODEL`.
  `HAMNIVO_LIVE_ANTHROPIC_MODEL` and similar variables pick the model. It is skipped by default.
- Capabilities are per provider. One model can still lack a feature; narrow it in the spec.
- OpenAI models use Chat Completions, not the Responses API.
- Errors are classified by status and provider error codes. If a provider changes its error
  bodies, an error can land in a broader kind, such as `invalid_request` for `context_length`.
- If Gemini sends an error inside a stream, `@ai-sdk/google` 4.0.82 drops it: the stream ends
  with finish reason `other` and no error part, so neither the normalizer nor `withFallback` sees
  it. Treat a Gemini stream that finishes with `other` as failed.
- The mock embedding model matches shared words. It knows nothing about meaning or synonyms.
