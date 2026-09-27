# @hamnivo/adapters

Provider adapters behind Hamnivo's shared contracts.

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
