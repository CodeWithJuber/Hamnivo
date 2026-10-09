# ADR 0012: Blocking visitors without IP addresses

- Status: accepted
- Date: 2026-10-09
- Builds on: the visitor tracking design (no IP is read or stored)

## Context

Owners moving from tawk.to expect to ban abusive visitors. tawk.to bans by IP address. Hamnivo
reads no IP address anywhere: visitor tracking keeps a hash of a random browser key, country
comes from the edge's header for one request and is never stored, and sessions carry a customer
principal. Storing an IP to ban would mean keeping personal data about every visitor, would
punish everyone behind the same network (offices, mobile carriers), and is easy to get around
with a VPN anyway.

## Decision

- **A block is on who Hamnivo already knows, never on an IP.** `visitor_blocks` names the
  customer principal behind a chat, the browser key a visitor reported from, and, for a
  customer the brand's website signed in, that account's subject. The owner chose this, knowing
  that clearing the browser gets around a block on an anonymous visitor.
- **Blocked customers can still read and make privacy choices.** The widget guard refuses chat
  writes (start, send, contact form, reopen, uploads, actions) with `CHAT_UNAVAILABLE`, and a new
  session says `chatAvailable: false`. Reading their own conversations, help search, memory and
  email choices, read receipts and signing out stay open, so a block never takes away a privacy
  right.
- **They are never told.** The widget shows the same "Chat isn't available right now." that any
  unavailability would. The error and the configuration never mention a block.
- **A blocked browser is not followed.** The tracker stores nothing for it and offers no
  invitations.
- **Blocks are lifted, not deleted.** Who blocked whom, why and until when stays on record and in
  the audit log. Lifted and expired blocks are removed after 90 days by maintenance. The
  application role cannot delete a block.
- **Who may block.** `visitors.block`, held by administrators and supervisors. A block from a
  chat checks the permission on that conversation; from Live visitors, on the visitor's brand.

## Consequences

- A determined anonymous visitor can come back by clearing their browser. Signed-in customers
  stay blocked on every device.
- The guard does one indexed `exists` check on chat writes only; reads pay nothing.
- A block does not reach other brands of the same tenant: brands keep their own lists.

## Addendum: senders on email, WhatsApp and Telegram (ADR 0013)

Channel customers (`customer_principals.kind = 'channel'`) are known by their address, so a
block from one of their conversations names that principal, like any other block. There is no
widget to refuse them, so the channel side decides instead:

- **Messages are kept, and nobody answers.** A blocked sender's message still enters the ledger.
  Then nothing else starts: no AI turn, routing, automation event, ticket or team. Hamnivo
  queues `conversation.close_blocked`, which writes a keyed private note ("Closed
  automatically: this sender is blocked.") and resolves the conversation as the integration.
- **Adoption is quiet.** A new conversation from a blocked sender gets its control row, but no
  ticket, default team or hand-over to people.
- **Closing it is not a chat for automations.** The `chat_closed` event is skipped for a
  blocked customer.
- **The sender is never told.** Chatwoot receives every message, and nothing is sent back.
- **One address, one channel.** A block covers that address on that channel kind for the
  brand. The same person's other addresses are other customers (ADR 0013).
- **The address is not copied.** The Blocked list reads the address from the customer, so
  erasing the customer erases it there too.
