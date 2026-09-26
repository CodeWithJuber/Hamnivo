# Contract compatibility rules

Applies to everything exported by `@hamnivo/contracts`: REST resources, the realtime event
envelope, message parts, cards, error codes and the widget bridge protocol (blueprint E04, D01).

## Versioning

| Change | Version | Allowed? |
|---|---|---|
| New optional field, new event type, new part type, new card kind, new error code | minor (`1.0` → `1.1`) | Yes — consumers must tolerate it |
| New enum value in a field consumers switch on | minor | Only with a documented fallback (see below) |
| Removing or renaming a field, changing a type, tightening validation | major | New route prefix (`/v2`) and event `schemaVersion` `2.x`; `v1` stays served through the deprecation window |

`schemaVersion` in every event envelope is `major.minor`. Consumers accept any minor version of
the major they were built for.

## Consumer rules (enforced by `parseEvent` / `parsePart`)

1. Unknown fields are ignored, never rejected (objects are non-strict).
2. Unknown event types resolve to `{ kind: 'unknown' }`; clients advance their cursor and move on.
3. Unknown message parts become `{ type: 'unknown', fallbackText }`; the widget shows the fallback
   text, or nothing when there is none.
4. A known type that fails validation resolves to `{ kind: 'invalid' }` (events) or an unknown part
   (parts) — never a thrown exception inside a render or stream loop.
5. Money is always an integer string in minor units with an ISO 4217 currency; clients never do
   float arithmetic on it.

## Producer rules

1. Never emit a field that older consumers would misread; add a new field instead.
2. Rich parts and cards always carry `fallbackText` so text-only channels and older SDKs degrade
   gracefully.
3. Fixtures for every published minor version live in `packages/contracts/fixtures/v1/` and must keep
   parsing (`packages/contracts/test/contracts.test.ts`).
4. The OpenAPI document `packages/contracts/openapi/hamnivo.v1.json` is generated; CI fails when it is
   stale. A diff that removes or narrows anything in it is a breaking change and needs a major version.

## Deprecation window

A superseded major version stays available for at least 12 months after its successor ships, with
`Deprecation` and `Sunset` response headers (RFC 9745 / RFC 8594) from the day the successor is
released.
