# ADR 0013: Hamnivo follows every conversation in its Chatwoot account

- Status: accepted
- Date: 2026-10-09
- Builds on: ADR 0001 (Chatwoot is the conversation authority), ADR 0010 (tickets are
  conversations)

## Context

Hamnivo answered only on its web widget. The widget opens each conversation itself: it records
a `conversation_controls` row, then sends every customer message through the message ledger
(`hv1:m:` keys). Routing, automations, memory and the AI all start from that ledger.

Chatwoot already runs email (IMAP/SMTP), WhatsApp Cloud and Telegram inboxes, and its account
webhook already sends Hamnivo their events. The processor dropped them, because only conversations
with a control row counted. Owners moving from tawk.to expect one inbox for every channel.

## Decision

- **Channel inboxes are recorded, not created, here.** A Chatwoot inbox that is not an API inbox
  gets an `authority_inboxes` row with `purpose = 'channel'`. Discovery lists the account's
  inboxes every five minutes, and on "Check for new channels". Each brand has its own Chatwoot
  account, so a new channel answers for that brand. The brand's one web chat inbox stays `live`.
- **Conversations are adopted.** When an event arrives for a conversation without a control row,
  on an active and unpaused channel inbox, Hamnivo records one:
  - for the inbox's brand;
  - for a channel customer;
  - owned by the AI only if Chatwoot gave it to Hamnivo's bot, and handed to people otherwise.

  A conversation carrying `hv_conversation` is never adopted: that is a widget conversation whose
  webhook beat the widget's own record. Adoption keys on the existing unique
  `(connection, external conversation)`, so a conversation seen twice is adopted once.
- **Channel customers are known by their address.** `customer_principals.kind = 'channel'`
  carries the channel and the address: the email address, the phone number, or the Chatwoot
  contact for Telegram. The same address is one customer across conversations. It is
  self-reported, so it is never verified and never merged with a signed-in customer. Memory stays
  off for them, because they never gave consent.
- **Incoming messages enter the ledger.** A customer message from a channel gets a committed
  ledger row keyed `hv1:x:` (derived from the conversation and Chatwoot's message id). It then
  starts what a widget message starts: the AI's turn, routing on the first message, and the
  automation events. Nothing downstream changed. The key is Hamnivo's own and never sent to
  Chatwoot.
- **The AI answers on a channel only when the owner says so.** `ai_answers` is off by default.
  Turning it on attaches Hamnivo's bot to the Chatwoot inbox; turning it off, or pausing,
  detaches it. Chatwoot then leaves new conversations with people. If a bot owns a conversation
  anyway, adoption hands it to people with the reason `channel_ai_off`.
- **Lost webhooks are covered.** Each channel inbox has an inbox cursor (`reconcile_cursors`,
  scope `inbox`). Every minute it lists the inbox's recent conversations and adopts any that
  Hamnivo missed. An adopted conversation's cursor starts at message 0, so the messages before the
  adoption are read once too.
- **Credentials stay in Chatwoot.** Hamnivo stores no mailbox password or channel token.
  Connecting channels from Studio passes them straight to Chatwoot, and redaction keeps them out
  of logs (PR B, PR C).

## Consequences

- Email, WhatsApp and Telegram conversations appear in the staff inbox, follow routing and
  automations, and can be answered by the AI where allowed.
- The Chatwoot account is shared with what Chatwoot itself does on those inboxes. Owners
  configure the channel in Chatwoot until Studio can connect it (next PRs).
- A conversation closed before Hamnivo first saw it is not adopted. It stays in Chatwoot's
  history.
- Blocking (ADR 0012) covers web chat. Blocking a channel address comes later.
