# ADR 0011: Automations run on the outbox

- Status: accepted
- Date: 2026-10-09
- Builds on: ADR 0001, ADR 0003, ADR 0010

## Context

Owners moving from tawk.to expect triggers: a greeting when a chat starts, a message when nobody
answers, a prompt on the pricing page, a ticket after hours. Hamnivo had website prompts (W19) with
three fixed kinds of trigger, edited in a dialog, and nothing that acted inside a chat.

Three facts shape how rules can run:

- Chatwoot is the conversation authority (ADR 0001). Anything a rule does to a chat has to reach
  Chatwoot, and a request to Chatwoot can fail, time out or be retried.
- The AI may own a chat (ADR 0003). Ownership changes are fenced by an epoch, and nothing else may
  speak while the AI answers.
- The loader on a brand's website has a 6 KB budget and no session. It cannot fetch a rule
  engine, and the gateway cannot see the page.

## Decision

- **One rule shape for both places: When, If, Then.**
  - When: one event.
    - Website: a page view, after some seconds.
    - Chats: chat started, customer waiting a number of seconds, chat closed, contact form message.
  - If: up to 10 conditions, all or any.
  - Then: up to 5 actions.
  - The shape is in the contracts. The pure evaluator is in `@hamnivo/domain/automations`, and the
    gateway, the loader and Studio's "Try it" all use it, so all three reach the same verdict.
  - No rules library: a general engine would not fit the loader, and the contracts already validate
    the shape.
- **Drafts and versions.**
  - Studio saves a draft. Publishing keeps an immutable version, and only the published version runs.
  - A stale editor cannot overwrite a newer draft or publish it blindly (a revision number).
  - Any version can be restored into the draft.
- **Website rules are split between the gateway and the browser.**
  - The gateway decides the conditions it knows when the loader asks: country (from the edge's
    header, never stored), language, business hours and who is online.
  - It hands the loader only what is left: the page address, the referrer, visits and the device.
  - The launcher response is private to the visitor's browser and is never shared through a cache.
  - The brand's daily limit and quiet time stay on the brand.
- **Chat rules run in the worker, from the outbox.**
  - The places that record what happened (the first customer message, each customer message, a
    close, a contact form message) queue `automation.event` in the same transaction.
  - They queue it only when the brand has a published chat rule.
  - "Waiting for a reply" is a delayed event per rule (`available_at`). When it is due, it asks
    Chatwoot whether anything was said to the customer since their message, the same fence as the
    delayed safety wording.
- **Safe to repeat, never louder than people.**
  - A rule acts at most once per conversation and event (`automation_runs`, unique).
  - Each action is idempotent:
    - a message key and a note key;
    - sets for tags, team, priority and ticket.
  - A message is never sent while the AI has the chat. A rule that sends one cannot be published
    unless it rules the AI out, and the worker reads the owner again under the conversation's lock.
  - At most five automated messages reach a conversation in a day.
  - Messages from automations are not customer messages, so they never start another rule.
  - A contact form message starts its own event, not "chat started", so a welcome rule does not
    answer a form.
- **Permissions.** `automations.read` and `automations.manage` replace `widget.proactive`. Custom
  roles that had it are moved over by the migration. Administrators manage automations;
  supervisors read them.

## Consequences

- W19's prompts became website rules: each brand's triggers were published as version 1, on or off
  as they were. Loaders cached from before (up to five minutes) show no prompt rather than a wrong
  one.
- Each run is in the audit log and in the rule's run log, which is kept for 90 days. Studio shows
  "ran N times this week" from it.
- Website prompts run in visitors' browsers and are not counted.
- A rule acts once per conversation and event. A rule that should act on every message would need
  another event key, which is left out for now.
- Conditions about the visitor's page, country and device in chat rules come from the visitor's
  latest visit, when visitor tracking is on. Without it, those facts are unknown, and an unknown
  fact never matches.
