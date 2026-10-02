# @hamnivo/migration-sdk

How Hamnivo reads chat history exported from other tools, and the format it imports and exports
(migration, M01–M08). The package has no I/O: it turns bytes into records and decides what an
import would do. The gateway's worker does the writing (`apps/gateway/src/migration`).

| Module | What it does |
|---|---|
| `src/model.ts` | The canonical model and the Hamnivo package format v1: contacts, conversations and messages as NDJSON records, an attachments manifest, and a manifest with counts and checksums. |
| `schema/hamnivo-migration-v1.schema.json` | The JSON Schema of the package, generated from the model (`pnpm --filter @hamnivo/migration-sdk schema`; the tests fail when it is stale). |
| `src/package/` | Reads and writes packages: a ZIP with a manifest, or bare NDJSON starting with the manifest line. |
| `src/adapters/` | One adapter per source: `tawk.ts` (tawk.to JSON export), `zendesk.ts` (full JSON export), `intercom.ts` (conversations in its API format) and `chatwoot.ts` (the fields and limits of another Chatwoot account, which the gateway reads into a package). |
| `src/open.ts`, `src/zip.ts` | Unpack an upload within size, count and path limits, and tell which source it comes from by its content. |
| `src/preflight.ts`, `src/fields.ts` | What an export holds before anything is imported: counts, the fields found (names only, never values) with how each is imported, required fields, known limits and records that need review. |
| `src/plan.ts`, `src/checkpoint.ts` | Every object found becomes exactly one item: pending, skipped as already imported, or quarantined with a reason. Items move pending → writing → imported, failed or quarantined; a write with an unknown outcome is resolved by its key. |
| `src/reconcile.ts` | The reconciliation report and its gate, and the rollback report. |
| `src/keys.ts`, `src/redact.ts` | Stable keys for imported messages, conversations and people (`hv1:imp:<job>:<source id>`), redaction of emails, numbers and link parameters in samples, and mentions made harmless. |

## Rules every adapter follows

- **Nothing is dropped silently.** A record that cannot be imported is an issue with a stable code
  (`missing_time`, `unsupported_sender`, `truncated` …), which becomes a quarantined item. A field
  Hamnivo does not import is listed as not imported.
- **Cut short is reported.** A conversation holding fewer messages than its source declares is
  marked, and one whose messages are missing altogether is not imported: importing half of it
  would make a later, complete import skip it as a duplicate.
- **People are never matched by typed-in addresses.** Only an identity the source verified can
  recognise a person again; emails and phone numbers are kept as not verified.
- **Files are links unless the export holds them.** Hamnivo never downloads from a link in an
  export.
- **No content in findings.** Issues, field lists and reports carry IDs, places in the export
  and counts, never message text or personal data.
- **IDs are scoped to where they come from** (`origin`): a Zendesk account's subdomain, a
  Chatwoot address and account, or a package's source.

## Sources

| Source | Upload | Known limits |
|---|---|---|
| tawk.to | The ZIP or JSON files of "Export chats" | 50 chats per export; file links only; no notes; typed-in emails. The REST API needs tawk.to's approval and is not used. |
| Zendesk | The ZIP of the full JSON export, with the users export added | Comments of tickets over 1 MB are left out (those tickets are listed as cut short); without the users export, authors other than the requester are known only from assignments and notes. |
| Intercom | JSON or NDJSON of conversations as its API returns them | Intercom has no export file with message text; its API gives the latest 500 parts of a conversation. HTML becomes plain text; events are left out. |
| Hamnivo | A package in the format above | Files listed only as links are not imported. |
| Chatwoot | Read by the gateway with an access token | A set number of conversations per import, oldest first; activity messages are left out. |

The adapters were written from each vendor's documentation and tested with fixtures in that shape
(`test/fixtures/`, made-up people). They have not yet been checked against real exports.

## Test

```bash
pnpm --filter @hamnivo/migration-sdk test
```
