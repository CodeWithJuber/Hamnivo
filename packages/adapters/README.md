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

## Jev decisions

`@hamnivo/adapters/jev` implements the `DecisionProvider` port from `@hamnivo/domain` with Jev. It
uses the official `@typesafe-ai/sdk` (MIT, pinned at 0.6.0). See ADR 0006.

```ts
import { createJevDecisionProvider } from '@hamnivo/adapters/jev';

const jev = createJevDecisionProvider({
  apiKey, // from the secret store
  model: 'jev-1.13.0', // required and pinned; 'jev-latest' is refused
});

const result = await jev.decide({
  task: 'handoff-advisory',
  rubricVersion: 'handoff-v1',
  language: 'hinglish',
  state: { message: 'Order pay ho gaya, delivery nahi mili.' },
  questions: {
    needsHuman: { type: 'noul', instructions: 'The customer needs a person to resolve this.' },
  },
  signal,
});
```

Jev answers bounded questions. It never authorizes, never computes money or dates, and never writes
replies. An explicit request for a person never goes to Jev: `detectHumanRequest` in
`@hamnivo/domain` handles it first.

### What the adapter guarantees

- One attempt per call. The SDK never retries.
- A total deadline: 1.5 s by default, or `deadlineMs` per provider or per request. The adapter
  enforces it itself, because the SDK timeout is per attempt. The call settles on time even when the
  transport ignores cancellation.
- Cancellation through `signal`.
- A circuit breaker. After 5 consecutive unavailable results it stops calling Jev for 30 s. Then it
  lets one probe through, and a success closes it. Caller aborts do not count as failures.
- Questions and answers are keyed maps by question name (E08).
  `test/jev/fixtures/systemone-request.json` shows the exact request body.
- Every result records the model version, rubric version, answers, latency, token usage and request
  id (J07).
- No logging. SDK logging is off, and the adapter never writes the state or bodies anywhere.
- The SDK's environment fallbacks are not used. The endpoint defaults to `https://api.typesafe.ai`.

### How results map

| Jev outcome | Result |
|---|---|
| Valid answers from the pinned model | `decided` |
| A missing answer, a wrong type, a label not offered, a number that is not finite, a probability outside 0 to 1, answers as an array, another model version, or no token usage | `invalid` |
| HTTP 400, 422 and other 4xx not listed below | `invalid` |
| HTTP 401, 403 or 404 | `unavailable`, not retryable |
| HTTP 408, 429 (with `retryAfterMs`) or 5xx, a connection failure, or the deadline passed | `unavailable`, retryable |
| The caller aborted | `unavailable`, not retryable |
| The breaker is open | `unavailable`, retryable, reason `circuit_open` |

`unavailable` never means false, safe or approved. Fall back to a deterministic rule first, then to
an explicitly configured alternative provider, then abstain to the manual queue. Ordinary messaging
never waits on Jev.

Noul answers carry only a probability. The adapter drops any confidence the wire sends with them.

### Tests and what is not verified

`test/jev/` checks the contract with an injected `fetch` and fixture JSON. No test calls the
network. No live Jev call has been made. Account access, quotas, data handling and regional latency
still need checking before production use.

## Cache stores

`@hamnivo/adapters/cache` keeps cache entries behind one interface (K12). Policy lives in
`@hamnivo/domain` (`cacheKey`, `cacheEligibility`): a store only keeps opaque strings until they
expire and never decides what may be cached.

| Export | What it does |
|---|---|
| `createValkeyCacheStore({ commands, prefix })` | Valkey through `GET`, `SET … PX [NX]` and `DEL`. Every key starts with `prefix`, so deployments and test runs never meet. The gateway adapts its ioredis connection to `ValkeyCommands`; this package has no client dependency. |
| `createMemoryCacheStore({ maxEntries, clock })` | In-process store with expiry and a size bound, for tests and development. |
| `failOpen(store, { timeoutMs, onFailure })` | Every operation gets a deadline. Failures and timeouts read as misses (`get` → null, `setIfAbsent` → false, `delete` → 0), so a cache outage never blocks a reply or a human message (K08). `onFailure` gets the operation and kind, never keys or values. |
| `createSingleflight()` | Concurrent work for one key in one process runs once; the others share its result or error. |
| `coalesce({ store, lockKey, waitMs, read, compute })` | Across processes: the lock holder computes, others poll for its result for at most `waitMs`, then compute themselves. |

`test/cache/store.test.ts` runs the same contract over the memory store and the Valkey store (on
a fake with Valkey's `PX`, `NX` and `DEL` semantics), and checks prefix isolation, fail-open
timeouts and errors, singleflight and bounded coalescing. The gateway's integration tests run the
Valkey store against a real Valkey.

## Commerce

`@hamnivo/adapters/commerce` is the payment-provider port (`CommerceProvider` in `port.ts`) with two
adapters:

| Adapter | Use |
|---|---|
| `StripeCommerceProvider` | Stripe, through the official `stripe` SDK: prices as the catalog (a price is a variant), Checkout Sessions as the hosted payment page, refunds, and webhooks verified with `stripe.webhooks.constructEvent` over the raw body. |
| `MockCommerceProvider` | An in-memory store with the same behaviour and Stripe-shaped, Stripe-signed events. Used by tests and demos; the gateway refuses `mock` connections in production unless `COMMERCE_ALLOW_MOCK` is set. |

The gateway builds a Stripe adapter per merchant connection, with the key it reads from its
secret broker; nothing here reads keys from the environment. Every write carries the caller's idempotency key and Hamnivo's
reference in metadata, so a lost answer can be found by `findCheckout` or `findRefund` without
creating anything. Errors are `CommerceProviderError` with `retryable` and `mayHaveApplied`:
a timeout may have applied, so the caller treats it as unknown, never as a failure.

`capabilities()` returns a versioned manifest (catalog, hosted checkout, full and partial
refunds, currencies, recurring, provisioning). The gateway checks every operation against it
before calling the provider.

### Tests

- `test/commerce/contract.ts` is one suite that both adapters pass: catalog, exact quotes,
  checkout, payment events, expiry, refunds, lost answers and dropped requests found by reference,
  webhook signatures (tampered, stale, other secret).
- The Stripe adapter runs that suite against `startFakeStripe()` (`@hamnivo/adapters/commerce/testing`),
  a stateful fake of the Stripe API and hosted page that the gateway and browser tests also use.
- `test/commerce/stripe-mock.test.ts` sends the adapter's requests to the official stripe-mock,
  which checks them against Stripe's OpenAPI description. It runs when `STRIPE_MOCK_URL` is set:

  ```bash
  docker run --rm -d --name stripe-mock -p 127.0.0.1:12111:12111 stripe/stripe-mock:latest
  STRIPE_MOCK_URL=http://127.0.0.1:12111 pnpm --filter @hamnivo/adapters test
  ```

No test calls the real Stripe API. The adapter has not yet been run against Stripe's live test
mode.

## Tools: MCP and the egress guard

`@hamnivo/adapters/mcp` lets the AI use tools on remote MCP servers (D10), through the official
`@modelcontextprotocol/sdk`. MCP is only a way to reach tools: Hamnivo's gateway decides which
tools exist, who may call them and who approves.

| | Supported |
|---|---|
| Transport | Streamable HTTP to a remote server, over HTTPS. No local (stdio) servers and no fallback to the older HTTP with SSE transport. |
| Protocol revisions | `2025-11-25`, `2025-06-18` and `2025-03-26` (`MCP_SUPPORTED_PROTOCOLS`). The client offers the newest; a server that answers with another revision is refused before any tool is listed or called. |
| Authentication | None, or a bearer token per server (`Authorization: Bearer …`). The gateway keeps the token in its secret broker and reveals it only for the request. OAuth is not supported yet. |
| Requests used | `initialize`, `tools/list` (at most 200 tools over 10 pages) and `tools/call`. Resources, prompts, sampling and elicitation are not used. |
| Network | Every request goes through the egress guard below. |

| Export | What it does |
|---|---|
| `listMcpTools(endpoint, signal?)` | The server's tools with their names, descriptions, schemas and annotations, all as untrusted data, plus the revision the server chose. |
| `callMcpTool(endpoint, name, args, { idempotencyKey, signal })` | One call. The idempotency key goes in `_meta['hamnivo/idempotency-key']`, for servers that honour it. Returns `isError`, structured content and text. |
| `McpCallError` | `kind` (`egress`, `timeout`, `network`, `refused`, `protocol`) and `mayHaveApplied`. A refusal did nothing; a timeout or lost connection after sending may have, so the gateway records the outcome as unknown and checks it rather than sending again. |
| `startFakeMcpServer()` (`@hamnivo/adapters/mcp/testing`) | A real Streamable HTTP server on 127.0.0.1 with scripted tools, faults before or after a change, a chosen protocol revision, and a record of calls and tokens. |

`@hamnivo/adapters/egress` (X05) is the only way tool calls reach the network. A request goes out
only when it uses HTTPS, its host is on the allowlist (`orders.example.com`, or `*.example.com`
for subdomains), and every address the host resolves to is public. The address check runs inside
the socket's own DNS lookup, so the checked address is the connected address (no DNS rebinding).
Redirects are not followed and responses stop at a size limit. Plain HTTP and loopback addresses
work only with `TOOLS_EGRESS_ALLOW_PRIVATE`, which the gateway refuses in production.

### The reviewed tool allowlist

What a server says about its tools is never trusted. The gateway:

- puts every new tool, and every tool whose name, description, schema or annotations changed, in
  review. A tool in review cannot be called or granted to an agent, and open approvals for a
  changed tool are cancelled. Someone with `tools.manage` sets its risk, approver and limits,
  then enables it (Studio, Tools and permissions);
- writes the tool's description itself. The server's description is kept as plain text for the
  reviewer; the model sees only the description that Hamnivo or the reviewer wrote;
- reduces input schemas to a portable subset (`sanitizeToolSchema` in `@hamnivo/domain`): unknown
  keywords are dropped, `pattern` is removed from untrusted schemas, and anything that cannot be
  represented safely is refused;
- gives each tool its own egress allowlist, starting with the server's host. A call is refused
  unless that list covers the server;
- treats results as data: size limited, cleaned to plain JSON, fenced in the prompt as untrusted,
  and never followed as instructions.

### Tests and what is not verified

- `test/mcp.test.ts`: listing as data, the bearer token, the idempotency key, a lost answer after
  the change, a failed tool, refused servers, cancellation, each supported revision and the
  refusal of another.
- `test/egress.test.ts`: address ranges, the allowlist, DNS rebinding, redirects and size limits.
- The gateway's `test/tools.int.test.ts` connects a fake server, reviews its tools, and checks
  that a changed listing goes back to review and that calls keep to the allowlist.

No test talks to a third-party MCP server.
