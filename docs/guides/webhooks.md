# Webhooks

Webhooks tell your systems what happens in Hamnivo while it happens: a conversation starts, the
customer is waiting for a person, an order is paid. Hamnivo sends a signed HTTPS `POST` to each
endpoint you add, for the event types you choose.

Deliveries follow [Standard Webhooks](https://www.standardwebhooks.com/). Any Standard Webhooks
library can check them, and so can the Hamnivo server SDK (`@hamnivo/server`).

## Who can manage webhooks

| Permission | Lets a person | Roles that have it |
|---|---|---|
| `webhooks.read` | See endpoints, the delivery log and the event log. Never a signing secret. | Owner, Administrator, Developer |
| `webhooks.manage` | Add, change and delete endpoints, send test events, rotate secrets, replay deliveries | Owner, Administrator, Developer |
| `network.manage` | Change the [allowed hosts](#allowed-hosts) | Owner, Administrator |

`webhooks.manage` and `network.manage` also need a sign-in from the last 10 minutes
(`STEP_UP_MAX_AGE_MINUTES`). Studio asks for your password again when it is older. API keys can be
given `webhooks.read` only. Every change is in the audit log.

## Add an endpoint

In Studio, open **Developer → Webhooks → Add endpoint**. Give the address, an optional description,
and the events to send. Or use the API:

```bash
curl "${h[@]}" -d '{"url":"https://hooks.example.com/hamnivo","description":"Order system",
  "eventTypes":["conversation.created","handoff.requested","order.updated"]}' \
  $A/v1/admin/webhooks/endpoints
```

(`h` and `A` are set as in [the identity guide](identity.md#who-can-register-keys).)

The answer has the endpoint and its **signing secret**, `whsec_…`. It is shown this once. Hamnivo
keeps it encrypted in its secret store and shows only its last four characters afterwards. Store it
with the receiving system.

The address must be HTTPS on the public internet. Hamnivo refuses:

- private, loopback, link-local and other special-use addresses (for example `10.0.0.5`,
  `127.0.0.1`, `169.254.169.254`, `fd00::1`), also when a public name resolves to one;
- user names and passwords in the address;
- hosts not on the workspace's [allowed hosts](#allowed-hosts), when it has a list.

The same checks run again at every delivery, on the address the name resolves to at that moment,
so a name that later points somewhere private is refused then (DNS rebinding). Redirects are never
followed: a `3xx` answer counts as a failed attempt.

The plan can limit the number of endpoints. Past the limit, adding one is refused with
`402 PLAN_LIMIT_REACHED` and the numbers in `quota`.

### Send a test event

**Send test event** (or `POST /v1/admin/webhooks/endpoints/{id}/test`) sends a signed
`webhook.test` event at once and shows the answer. A `2xx` answer marks the endpoint as verified.
A test is not retried.

## What a delivery looks like

```http
POST /hamnivo HTTP/1.1
Host: hooks.example.com
Content-Type: application/json
User-Agent: Hamnivo-Webhooks/1.0
webhook-id: evt_01k6p0d2d4fbcsa0m2b3x8q9tz
webhook-timestamp: 1790966353
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"id":"evt_01k6p0d2d4fbcsa0m2b3x8q9tz","type":"conversation.created",
 "timestamp":"2026-10-02T18:39:13.120Z","schemaVersion":"1.0","tenantId":"tnt_…",
 "data":{"conversationId":"cnv_…","brandId":"brd_…","channel":"Channel::WebWidget",
 "createdAt":"2026-10-02T18:39:13.120Z"}}
```

- `webhook-id` is the event's ID. It stays the same on every retry and replay, so use it to
  ignore a delivery you have already processed.
- `webhook-timestamp` is when this attempt was signed, in Unix seconds.
- `webhook-signature` holds one signature, or two (space-separated) while a rotated secret is
  still in its overlap.
- The body is one JSON object of at most 256 KB: `id`, `type`, `timestamp` (when it happened),
  `schemaVersion`, `tenantId` and the event's `data`. The schema of every event is in the API
  reference (`/docs`, under webhooks), and `GET /v1/admin/webhooks/event-types/{type}/sample`
  returns an example.

## Check the signature

Check every delivery before you use it. With the server SDK:

```ts
import { MemoryReplayStore, verifyWebhook } from '@hamnivo/server';

const replays = new MemoryReplayStore();

app.post('/hamnivo', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body, req.headers, {
      secret: process.env.HAMNIVO_WEBHOOK_SECRET,
      replayStore: replays,
    });
    await handle(event); // event.type, event.data …
    res.sendStatus(204);
  } catch (error) {
    // HamnivoWebhookError: error.code is missing_header, invalid_timestamp,
    // timestamp_out_of_range, invalid_signature, duplicate or invalid_payload.
    res.status(400).end();
  }
});
```

`verifyWebhook` needs the raw body exactly as received: parse the JSON only after the check. It
refuses a timestamp more than 5 minutes away from your clock (`toleranceSeconds`), and, with a
replay store, an ID it has already accepted. During a secret rotation, pass both secrets
(`secrets: [newSecret, oldSecret]`). A runnable example is in
[`examples/node-express`](../../examples/node-express).

By hand, in any language:

1. Take the secret without its `whsec_` prefix and decode it from base64. These bytes are the key.
2. Compute HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`, and encode it in
   base64.
3. Accept the delivery when one of the `v1,…` entries in `webhook-signature` equals it. Compare in
   constant time.
4. Refuse a timestamp more than 5 minutes old or ahead, and an ID you have already processed.

## Answer quickly

Answer with any `2xx` status within 15 seconds (`WEBHOOK_TIMEOUT_MS`). Do slow work after
answering. Anything else is a failed attempt: another status, a redirect, a timeout, a connection
or certificate error. Hamnivo reads at most 16 KB of the answer and keeps the first 300 characters
in the delivery log, with anything that looks like a key or token replaced.

A failed delivery is tried again after about 5 seconds, 5 minutes, 30 minutes, 2, 5, 10, 14, 20
and 24 hours: 10 attempts over about three days. Each wait varies by up to 20%, so retries from
many endpoints do not arrive together. A `Retry-After` header is respected, up to 24 hours.
`410 Gone` turns the endpoint off at once.

An endpoint is also turned off after it keeps failing: 10 failed attempts in a row that span at
least 72 hours (`WEBHOOK_DISABLE_AFTER_FAILURES`, `WEBHOOK_DISABLE_AFTER_HOURS`). Studio shows
why. Deliveries waiting for a retry are then cancelled; turn the endpoint on and replay them.

## Events

| Type | Sent when | `data` |
|---|---|---|
| `conversation.created` | A conversation started. | `conversationId`, `brandId`, `channel`, `createdAt` |
| `conversation.updated` | Who answers, or the status the customer sees, changed. | `conversationId`, `status`, `responder` |
| `conversation.resolved` | A conversation was resolved. | `conversationId`, `canReopen` |
| `conversation.reopened` | A conversation was reopened. | `conversationId` |
| `message.created` | A message the customer can see was sent. | `conversationId`, `message` |
| `handoff.requested` | The conversation is waiting for a person. | `conversationId`, `reason`, `from`, `to`, `staffId`, `at` |
| `handoff.accepted` | A person took the conversation. | as `handoff.requested` |
| `handoff.returned` | The conversation went back to the AI assistant. | as `handoff.requested` |
| `order.created`, `order.updated` | An order was placed or changed state. | `order`: `id`, `reference`, `conversationId`, `state`, `previousState`, `paymentState`, `fulfillmentState`, `currency`, `totalMinor`, `placedAt` |
| `payment.updated` | A payment changed state. | `payment`: `id`, `orderId`, `state`, `previousState`, `currency`, `amountMinor`, `capturedMinor`, `refundedMinor` |
| `refund.created`, `refund.updated` | A refund was requested or changed state. | `refund`: `id`, `orderId`, `state`, `previousState`, `currency`, `amountMinor`, `reason` (a code; the staff note is never sent) |
| `memory.deleted` | Customer memory was deleted. | `deletion`: `id`, `customerId`, `scope`, `reason`, `recordCount`, `completedAt` (a receipt, never the content) |
| `usage.threshold_reached` | Usage reached an alert threshold of a plan limit or budget. | `limit`, `source`, `threshold`, `used`, `max`, `period` |
| `webhook.test` | You sent a test event. | `endpointId`, `message` |

Never sent: internal notes, anything only staff can see, the content of deleted memory, and any
secret or token.

## Delivery log and replays

Open an endpoint in Studio to see its deliveries: each attempt with its status, time taken and the
start of the answer, and a preview of the event with what people wrote and who they are hidden.
**Developer → Event log** lists every event with how its deliveries went.

- **Replay this delivery** sends a failed or cancelled delivery again.
- **Replay failed** sends again every delivery that failed in the last 24 hours, 3 or 7 days.

A replay carries the original `webhook-id` and a new signature. Events are kept for 30 days
(`WEBHOOK_RETENTION_DAYS`), so older deliveries can no longer be replayed. The delivery log, without
the events, is kept for 90 days (`WEBHOOK_LOG_DAYS`).

## Rotate a signing secret

**Rotate secret** (or `POST /v1/admin/webhooks/endpoints/{id}/rotate-secret`) shows a new secret
once. For the overlap you choose (none, 1 hour, 1 day or 3 days), each delivery is signed with both
secrets. Give the receiver the new secret during the overlap; then the old one stops signing.

## Allowed hosts

**Developer → Allowed hosts** limits the hosts Hamnivo may call for the workspace. With no hosts
listed, any public host is allowed. A host is a name such as `hooks.example.com`, or
`*.example.com` for its subdomains. Endpoints outside the list are shown, and their deliveries are
refused until the host is added. Private and local addresses stay refused whatever the list says.

The server administrator can trust some origins for every workspace, for example a service on the
same private network: `EGRESS_TRUSTED_ORIGINS=http://10.0.0.5:8080` (comma-separated). Those may
use plain HTTP and private addresses. Leave it empty unless you need it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | `15000` | How long one attempt may take. |
| `WEBHOOK_CONCURRENCY` | `8` | Deliveries the worker sends at the same time. |
| `WEBHOOK_RETENTION_DAYS` | `30` | Days events are kept for replays. |
| `WEBHOOK_LOG_DAYS` | `90` | Days the delivery log is kept. |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | `10` | Failed attempts in a row before an endpoint is turned off… |
| `WEBHOOK_DISABLE_AFTER_HOURS` | `72` | …when they span at least this many hours. |
| `EGRESS_TRUSTED_ORIGINS` | empty | Origins trusted for every workspace (plain HTTP and private addresses allowed). |
