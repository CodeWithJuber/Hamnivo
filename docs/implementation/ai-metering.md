# AI metering and funding

Text generation records its credential source explicitly. A configured tenant model connection is BYOK; a model without a connection uses the configured platform provider credential. A BYOK agent does not fall back to a platform-funded model. Missing or disabled tenant credentials fail closed.

`ModelFactory.executeAttempt` wraps the SDK's provider `doGenerate` boundary. Each generation step, including tool-loop steps and explicitly selected fallback attempts, reserves capacity before the provider is called. The attempt key includes the operation, generation attempt, model choice and step. A duplicate key cannot start the provider again. Memory extraction keys remain tied to the original message across outbox replays, so deletion/review replays do not make another paid call. Replies, the playground, copilot suggestions, translation, memory extraction and workflow specialists use this entry point.

Managed calls reserve a conservative token allowance from prompt bytes, tool definitions and the output limit. Settlement uses measured provider input/output usage and writes the existing token usage ledger once. Existing run references and the separate delivered-reply meter are preserved; per-attempt deduplication includes all provider steps without double-writing the final response's tokens. BYOK usage is visible in the attempt ledger and consumes no managed token budget.

The default credit rate is a neutral internal unit: one token equals one credit, represented as 1,000 milli-credits. It is **not a dollar amount, a provider price, or a monetary invoice calculation**. Rate versions are immutable; settlement uses the rate selected before the request. Operators can publish explicit provider/model rate versions without changing previous receipts.

## Shared agency funding

New agency-created clients receive an explicit funding record. Existing clients linked into an agency retain their payer. Directory membership alone never transfers billing ownership. The server resolves funding, locks the payer row, and checks both existing token usage and outstanding reservations across funded clients before admitting a managed call. The child workspace retains its own applicable limits.

The cross-tenant allowance function returns only an allow/deny result. It cannot enumerate another workspace's attempts or balances. The usage API (`GET /v1/admin/ai/usage`, requiring tenant-wide `billing.read`) returns the current tenant's attempts and funding identity; it does not expose sibling or parent attempt history.

## Unknown outcomes

A complete provider receipt settles the attempt idempotently. An explicit authentication, validation or rate-limit rejection releases the hold. Reported usage on a failed response is still recorded.

A timeout, connection loss or incomplete usage receipt is not evidence of zero cost. Such attempts retain their conservative reservation and prevent blind retries. Expiry alone never refunds the hold. Partial receipts remain conservative until complete; repeated complete settlement cannot write token usage twice. Late receipts belong to the original billing period.

A process crash between dispatch and recording a response therefore leaves capacity held. A dedicated operator reconciliation workflow for these AI holds is not yet implemented. This limitation is preferable to silently resending an uncertain paid request or inventing a zero-cost receipt.

## Validation and limits

Fake-provider tests cover reservation ordering, actual usage, rejected requests, provider failures with usage, unknown outcomes and settlement failures. PostgreSQL integration tests cover concurrent funded-client requests, tenant isolation, duplicate and partial settlement, late receipts, BYOK at zero managed allowance, and refusal to substitute platform credentials for an inaccessible tenant connection. Selected existing playground tests exercise real runtime integration without provider credentials.

These checks did not call a real commercial model provider. Platform knowledge embeddings remain outside this text-generation ledger: the existing embedding interface has no tenant attribution. No embedding costs or monetary prices are fabricated. Real-provider qualification and tenant-attributed embedding metering remain separate work.
