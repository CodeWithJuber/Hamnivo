# @hamnivo/domain

Hamnivo's pure domain types and ports. It has no I/O and no framework dependencies.

## `ConversationAuthority` (`src/authority.ts`)

This is the port to the system that owns conversations and messages: Chatwoot CE today (see
`@hamnivo/chatwoot` and ADR 0001). References are opaque strings that the authority owns. No
Chatwoot type crosses the port.

### Capabilities

`capabilities` states what the authority guarantees:

- `messageKeys`: writes carry an idempotency key that is echoed back.
- `ownerCas`: ownership supports compare-and-set. Chatwoot does not, so Hamnivo fences AI
  publications with its own ownership epoch.
- `multiContact`: a conversation can have more than one contact.
- `customerEdits`: customers can edit messages.

### Writes

- Every write names the credential that performs it: `{ kind: 'bot' }`, `{ kind: 'integration' }`
  or `{ kind: 'staff', userRef }`. The authority then applies its own attribution and permissions.
- Message keys use fixed prefixes (`MESSAGE_KEY_PREFIX`):
  - `hv1:m:` for customer and staff messages
  - `hv1:p:` for AI publications
  - `hv1:n:` for notes
  - `hv1:imp:` for imports
- `findByKey` resolves writes whose outcome is unknown after a timeout.

The shared contract suite for implementations lives in `packages/chatwoot/test/contract/suite.ts`.

## Decisions (`src/decisions.ts`)

This is the provider-neutral port for typed decisions (ADR 0006). A provider answers named
questions about a minimized state. It suggests intent, ranks finite candidates and scores bounded
rubrics. It never authorizes, never computes money or dates, and never writes replies.

- Questions and answers are keyed maps by question name, never arrays:
  - `choice` picks one offered label. The answer has the label, a confidence and probabilities.
  - `score` rates an ordered rubric. The answer has an expected score, a confidence and
    probabilities.
  - `noul` asks how likely a proposition is. The answer is a probability from 0 to 1. It has no
    confidence, and none is ever made up.
- `DecisionProvider.decide` never throws. It returns one of four statuses:
  - `decided`: the answers, with the model version and rubric version.
  - `abstained`: no usable answer, with a reason.
  - `unavailable`: the provider could not answer. `retryable` says whether a later try may help.
    It never means false, safe or approved.
  - `invalid`: the request or the answer broke the contract.
- Every result records the provider, task, rubric version, language slice and latency. When known,
  it also records the model version, token usage and request id (J07).
- `applyThreshold(result, policy)` applies per-task and per-language thresholds:
  - Choice and score answers need a minimum confidence.
  - Noul answers use the probability: true at or above one value, false at or below another,
    abstain in between. A kept noul answer gains a `verdict`.
  - Thresholds hold only for the provider, model and rubric they were evaluated with. A task,
    language or question without thresholds abstains ("not evaluated for this language").
  - An abstained result keeps the observed answers for audit. Never route on them.
- `ROUTING_OUTCOMES` lists what policy may choose: `AI_CONTINUE`, `ASK_CLARIFICATION`,
  `INVITE_SPECIALIST`, `HUMAN_REVIEW`, `HUMAN_TAKEOVER` and `BLOCK_ACTION`. It is separate from the
  provider status.
- `createMockDecisionProvider({ rules })` is a deterministic offline provider. It answers from
  keyword rules, for tests and development.

## Human-request detection (`src/human-request.ts`)

`detectHumanRequest(text)` says whether a message explicitly asks for a person. It returns
`{ requested, phrase?, language? }`.

- It is deterministic and needs no provider. Run it first: an explicit request creates the handoff
  at once, and Jev cannot veto it.
- It covers English, Hinglish, Roman Urdu, Arabic, Hindi and Urdu.
- `normalizeForMatching` folds spelling before matching: case, Arabic and Urdu letter variants,
  diacritics and tatweel, Devanagari nukta and virama forms, punctuation, spacing and doubled
  letters (insaan and insan match).
- Negation stays within its clause. "I don't want a human" and "insaan nahi chahiye" are not
  requests. "no bot, human please" and "bot nahi, insaan chahiye" are.
- Look-alikes are not requests: "human resources", "are you human?", "agent number 5 delivered my
  order".
- The language tag is a hint. In Latin script, phrases with English or Hindi person words are tagged
  Hinglish, and phrases with Urdu words (insaan, banda) are tagged Roman Urdu.
- The cases live in `test/fixtures/human-requests.json`, so evaluation can reuse them.

## Commerce (`@hamnivo/domain/commerce`)

Pure rules for buying in chat. Nothing here does I/O; the gateway calls them.

| Module | What it does |
|---|---|
| `money.ts`, `currencies.ts` | Money as integer minor units (`bigint`) with an ISO 4217 currency. Adding different currencies throws. `applyRate` and `allocate` round explicitly (half-even by default) and never lose a minor unit. |
| `quote.ts`, `hash.ts` | The quote document, `verifyQuoteArithmetic` (lines, discount, delivery, tax and total add up exactly) and `quoteHash`: SHA-256 over RFC 8785 canonical JSON. The widget recomputes it before a customer approves. |
| `approval.ts` | `checkQuoteApproval`: the approval must name this quote's hash and cart revision, before the expiry. `quoteExpiry` takes the earliest of the shop's validity and the brand's limit. |
| `machines.ts` | State machines for cart, quote, purchase intent, payment, order, fulfilment, refund and operation. `nextState` returns `null` for a move that is not allowed; the tests list every allowed move and refuse the rest. |
| `capabilities.ts` | The provider capability manifest and `negotiate(capabilities, operation, context)`, which says whether an operation is supported and why not. |
| `refund-policy.ts` | `evaluateRefund` (amount left, window, partial refunds, approval threshold) and `checkRefundApprover` (the requester can never approve). |
| `claims.ts` | `checkCompletionClaims`: finds "paid" or "refunded" claims in a reply (in the four launch languages) and blocks them unless a provider receipt exists. |
| `format.ts`, `amount-input.ts` | Locale-safe display: money with its currency, times with their zone, calendar dates for estimates. `parseAmountInput` reads typed amounts in Latin, Arabic-Indic, Persian and Devanagari digits and returns `ambiguous` with the readings instead of guessing ("1,500"). |
| `live-data.ts` | Commerce data that must never come from a cache (K06): `answerCacheDecision` and the `no-store` header value. |
