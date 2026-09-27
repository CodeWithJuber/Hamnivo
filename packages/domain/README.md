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

## Language preferences (`src/language.ts`)

Interface locale, reply language, script, style and time zone are separate settings (U01). Reply
languages are BCP 47 tags: `en`, `ar`, `hi`, `ur`, `hi-Latn` (Hinglish) and `ur-Latn` (Roman
Urdu). Each maps to an evaluation slice (`SLICE_OF_LANGUAGE`).

- `detectLanguage(text)` returns `{ language, candidates, script, ambiguous }` for one message.
  - Order numbers, emails, web addresses and amounts are ignored, so `NL-1048 کہاں ہے؟` is Urdu.
  - Arabic and Urdu are told apart by letters and common words.
  - Latin text with Hindustani grammar words is Hinglish or Roman Urdu, never English, even
    when it is full of English nouns ("Order pay ho gaya, delivery nahi mili"). Most short
    messages fit both, so both are candidates and `ambiguous` is true.
  - Greetings, names and unknown words give no candidates. A name never decides a language.
- `resolveReplyLanguage(input)` chooses the reply language:
  1. an explicit choice always wins;
  2. a message whose language is clear decides;
  3. an ambiguous message keeps the previous language when it fits; otherwise the candidate that
     matches the interface locale (or the first) is suggested and the customer is asked to
     confirm once (`confirm`), never twice;
  4. without words, the previous language, then the interface locale, then English.
- `styleInstructions(style)` turns a customer's style (concise, conversational or formal; gentle
  or direct) into prompt lines that change wording only (U10).
- `textDirection(text)` says whether a message reads right to left by counting letters, ignoring
  identifiers. `bidiSegments(text)` splits out identifiers, amounts, emails and web addresses so
  they can be isolated left to right; the segments join back to the exact text.
- The cases live in `test/fixtures/language-detection.json`.

## Routing (`src/routing.ts`)

Intent and team routing (J02, U07). A decision provider may suggest the intent; code picks the
team.

- `routingQuestion(intents)` is a choice over the brand's intents plus `other`.
- `baselineIntent(text, intents)` is the deterministic baseline: keyword matches over normalized
  text. No match or a tie gives `other`.
- `chooseTeam({ intent, language, teams })` considers only teams that are accepting
  conversations. Among teams that handle the intent, one that speaks the language beats one with a
  reviewed translation path, which beats a language gap. Otherwise a default team is chosen the
  same way.
- `decideRoute(...)` uses a decided provider answer with an offered intent. Anything else
  (abstained, unavailable, invalid, a label that was not offered, or no provider) falls back to the
  baseline and records why. Routing only picks a destination: a customer who asked for a person
  has already been handed over before routing runs.
- `rankStaffForLanguage(staff, language)` orders people: available first, then those who speak
  the language, then by load.
- `summarizeExperiment(records)` reports provider versus baseline (J08): agreement on decided
  records, abstentions and failures counted separately, accuracy only against reviewer labels,
  latency percentiles and tokens, overall and per language slice.

## Cache keys and eligibility (`src/cache.ts`)

- `cacheKey(envelope, sha256)` builds the key from tier, tenant, brand, audience, language, model,
  prompt version, every dependency with its version, and a keyed digest of the input. The tenant
  and brand prefix the stored key. Keys never contain input text; incomplete envelopes throw.
- `cacheDependency` names dependencies (`knowledge:source:<id>`, `agent:<id>`, `brand:<id>`,
  `cache_policy:<brandId>:<tier>`). Bumping a version changes the key, so stale entries stop being read.
- `cacheEligibility(request, policy, { rules, forStore })` checks, in order: the tier is on, no
  excluded data class (personal, identity, account, memory, live order, payment, approval and tool
  results are never cached), not personalized, no side effects, no personal data in the input,
  then every added exclusion rule. Writes also need complete, validated output.
- `CacheExclusionRule` is the hook for other modules, such as commerce excluding live order
  questions (K06).
- Answers are off by default (`DEFAULT_CACHE_POLICY`); exact NLP and embeddings are on.

## Personal data (`src/privacy.ts`)

`findPersonalData(text)` lists the kinds of personal data a text seems to contain: emails, phone
numbers, payment cards (Luhn), IBANs, order and ticket references and street addresses, with
Arabic-Indic and Devanagari digits. `redactPersonalData(text)` replaces them with `[email]`,
`[phone]` and so on, for the minimized state sent to a decision provider. It errs towards finding
too much.
