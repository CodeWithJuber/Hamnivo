# API keys

An API key lets one of your servers call the Hamnivo API without a person signing in: for
example, to read reports into your own dashboards, check invoices from your accounting system, or
read the webhook delivery log. Each key acts as its own service account, with only the permissions
you give it.

## What a key can be given

| Permission | Lets the key |
|---|---|
| `analytics.read` | Read reports (`/v1/admin/analytics/overview`) and the CSV export. Aggregates only, never message content. |
| `billing.read` | Read the plan, usage against its limits, and invoices. |
| `webhooks.read` | Read webhook endpoints, the delivery log and the event log. Never a signing secret. |
| `mcp.read` | Let an AI assistant such as Claude read conversations (as customers see them), knowledge, customer memory and open hand-offs through Hamnivo's MCP server at `/mcp`. Read only. See [Let an AI assistant read your support data](../guide/ai/hamnivo-for-claude-and-chatgpt.md). |

A key never gets more than the person who creates it holds. Actions that need a person stay with
people: managing keys, webhooks, budgets, members and anything else that needs two-step
verification or a recent sign-in.

## Who can manage keys

`api_keys.read` lets a person see keys, their permissions and when they were last used.
`api_keys.manage` lets them create, rotate and revoke keys; it also needs two-step verification
and a sign-in from the last 10 minutes (`STEP_UP_MAX_AGE_MINUTES`). The Owner, Administrator and
Developer roles have both. Every change is in the audit log.

## Create a key

In Studio, open **Developer → API keys → Create key**. Give it:

- a **name** that says where it is used, such as "Order system";
- its **permissions**;
- **where it applies**: the whole workspace, or one brand (billing and webhooks always cover the
  whole workspace);
- when it **expires**: in 7, 30, 90, 180 or 365 days. Every key expires.

Or with the API, signed in with two-step verification (see [the identity
guide](identity.md#turn-on-two-step-verification)):

```bash
curl "${h[@]}" -d '{"name":"Order system","permissions":["analytics.read"],"expiresInDays":90}' \
  $A/v1/admin/api-keys
```

The key looks like `hv_live_8f3k2m1qa9bc_…` and is shown this once. The part up to the second
underscore group is its public prefix, which lists show. Hamnivo stores only an HMAC of the rest,
so nobody can read the key back, not even from a copy of the database. Keep it in your server's
secret store.

## Use a key

Send it as a bearer token. A key belongs to one workspace, so no workspace header is needed:

```bash
curl -H "authorization: Bearer hv_live_…" $A/v1/api-keys/current
curl -H "authorization: Bearer hv_live_…" \
  "$A/v1/admin/analytics/overview?from=2026-09-01&to=2026-09-30&timezone=Asia/Karachi"
```

- `401 AUTH_REQUIRED`: the key is wrong, revoked or expired.
- `403 SCOPE_DENIED`: the key was not given the permission, or the place is outside its scope.
- `429 RATE_LIMITED`: the key made more than 120 requests in a minute
  (`API_KEY_RATE_LIMIT_PER_MINUTE`, per key). Wait for the seconds in `Retry-After`.

Studio shows when each key was last used (updated at most once a minute).

## Rotate and revoke

**Rotate** gives a new key with the same permissions, shown once. The old key keeps working for
the overlap you choose (none, one hour, one day or one week), so you can update your integration
without a gap. **Revoke** stops a key at once and cannot be undone.

With the API: `POST /v1/admin/api-keys/{id}/rotate` with `{"overlapMinutes":60}`, and
`POST /v1/admin/api-keys/{id}/revoke`.

Keys and their secrets never appear in logs, the audit log, delivery logs or error messages.
