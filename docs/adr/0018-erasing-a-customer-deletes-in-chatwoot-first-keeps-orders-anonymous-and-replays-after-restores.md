# ADR 0018: Erasing a customer deletes in Chatwoot first, keeps orders anonymous and replays after restores

- Status: accepted
- Date: 2026-10-16
- Builds on: ADR 0001 (Chatwoot holds the conversation), ADR 0017 (retention deletes old
  conversations everywhere and keeps an anonymous report row)

## Context

A10 asks for a documented customer data export. Under the GDPR and similar laws a business must
answer two requests from one person: "send me what you hold about me" and "erase me". Until now
only a customer's memory could be exported or erased. Their profile, conversations, files, consents,
orders and Chatwoot contact were out of reach, so a business had to piece an answer together by hand
and could not erase anyone completely.

Four things make this more than a query and a `DELETE`:

- Chatwoot holds the transcripts, files and the contact. An answer or an erasure that stops at
  Hamnivo misses most of the personal data.
- Orders, payments and refunds are accounting records the business must keep, and every commerce row
  points at the customer with a column that cannot be emptied or changed.
- Internal notes are written by staff about the customer. They can name other people and hold
  opinions, so handing them over is a decision for the business, not something to do by default.
- Backups. A restore brings an erased customer back, and Chatwoot ids can be given to someone else
  after a restore, so "delete contact 42 again" can delete the wrong person.

## Decision

- **Two permissions, for people only.** `customers.export` needs a recent sign-in, also to download;
  `customers.erase` needs a recent sign-in and two-step verification. Both are per brand. Owners and
  the administrator preset hold them; neither can be given to an API key. Staff can only find
  customers of brands they hold one of them for.
- **Requests are rows the worker carries out.** Asking creates a `privacy_requests` row (kind, brand,
  customer id without a foreign key so it outlives the customer, state, reason, optional reference,
  who asked, counts, problem) and an outbox event. Asking again while one is waiting returns it.
  The worker claims it, retries failures through the outbox, and gives up after 10 attempts.
  Each step is audited with ids and counts only.
- **The export is what the customer saw.** One ZIP: `customer.json`, one file per conversation with
  the messages sent both ways (internal notes and activity left out), the files sent both ways (up to
  25 MB each and 200 MB in all; what is left out is listed), `consents.json`, `memory.json`,
  `orders.json`, `feedback.json`, `preferences.json`, a `manifest.json` with each file's SHA-256 and a
  `README.txt`. Conversations come from Hamnivo and from the customer's Chatwoot contacts, limited to
  the brand's inboxes. The file is kept 24 hours in `privacy_files`, each download is audited, and
  the person who asked is emailed when it is ready (a link to Studio, never to the file).
- **The erasure deletes in Chatwoot first, then in Hamnivo.**
  1. A tombstone is written first (`erasure_tombstones`, append-only): the customer id, the Chatwoot
     contact and conversation ids, and HMAC fingerprints of their subject, email, phone, handle and
     Chatwoot identifier, keyed per workspace and brand from the key-encryption key.
  2. Their chat sessions are revoked.
  3. In Chatwoot, their conversations in the brand's inboxes, then their contact. A contact that also
     has conversations of another brand stays, with those conversations.
     Chatwoot answering 401 or 403 stops the request as `blocked` (its Hamnivo user is not an
     administrator) before anything is deleted in Hamnivo.
  4. Their memory, through the memory deletion path with its receipt.
  5. `app.erase_customer`, a definer function that checks the request is a running erasure of the
     current workspace, then removes each conversation with `app.remove_conversation` (ADR 0017, so
     reports keep their numbers) and deletes their feedback, notifications, uploads, read marks,
     follow-ups, preferences, sessions and Chatwoot links.
- **Orders stay, anonymous.** The order's delivery details, checkout links, approval evidence,
  fulfilment notes and finance evidence are cleared. A customer with orders, quotes, carts or
  purchase intents becomes an anonymous stub: kind `anonymous`, no name, email, subject, handle or
  locale, and `erased_at` set. A customer without any is deleted. Consent records stay as proof.
- **Erasures survive restores.** A restore carries `privacy_requests` and `erasure_tombstones` over
  like memory deletions, then `app.apply_erasure_tombstones()` erases again any customer it brought
  back. In Chatwoot the worker deletes a tombstoned contact or conversation again only when the
  contact's email, phone or identifier fingerprint still matches, because the id may now belong to
  someone else. Imports skip a contact whose fingerprint matches a tombstone.

## Consequences

- A business can answer an access request with one file and an erasure request with one action,
  and both leave a record of who did it, when and why.
- Orders and the audit log keep a customer's id. With the name, contact details and delivery address
  gone, that id identifies nobody on its own.
- Internal notes are not in the export. A business that must hand them over reads them in the inbox
  and decides what to share.
- Data that already left Hamnivo is out of reach: webhook deliveries to the business's systems, and
  transcripts already emailed. Webhook bodies Hamnivo received are deleted after 30 days anyway.
- A Chatwoot contact shared with another brand keeps its name and details for that brand.
- Erased customers in backups come back on restore only until the restore's own replay erases them
  again.
