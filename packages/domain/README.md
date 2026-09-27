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
