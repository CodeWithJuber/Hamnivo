# @hamnivo/db

The Hamnivo database layer: Drizzle ORM schema, SQL migrations with row-level security,
tenant-scoped transactions, a hash-chained audit log and typed cross-tenant resolvers.

Conversations and messages are **not** stored here. Chatwoot is the conversation authority
(ADR 0001). These tables hold identity, grants, control state, ledgers, a short-lived realtime
journal and audit.

## Tenant isolation

| Layer | Mechanism |
|---|---|
| Roles | `hamnivo_app` (gateway, worker) has no superuser, owns nothing and cannot bypass RLS. `hamnivo_owner` runs migrations. `hamnivo_platform` reads metadata only. `hamnivo_resolver` (NOLOGIN, BYPASSRLS) owns the audited cross-tenant functions. |
| Row-level security | Every table has RLS **enabled and forced**. The `tenant_isolation` policy is `tenant_id = (select app.current_tenant())` for both reads and writes. |
| Tenant context | `withTenant(db, { tenantId }, tx => …)` opens a transaction and sets `app.tenant_id` with `set_config(…, true)`. The setting is transaction-local, so it cannot leak to the next use of a pooled connection. |
| Composite keys | Tenant tables have `UNIQUE (tenant_id, id)`, and foreign keys include `tenant_id`, so a row can never reference another tenant's row. |
| Pre-tenant lookups | Only through `app.resolve_*` SECURITY DEFINER functions: widget public id, API key prefix, webhook connection, widget session, staff memberships, tenant slug, and the SSO connection for an email domain or provider id. Each has a pinned `search_path`, column-level grants and no PUBLIC execute. |
| Partitions | Audit partitions are unreachable directly; access goes through the partitioned parent and its policies. |

## Using it

```ts
import { appendAudit, createDb, schema, withTenant } from '@hamnivo/db';

const db = createDb(process.env.DATABASE_URL!, { applicationName: 'hamnivo-gateway' });

await withTenant(db, { tenantId, actorId: staffId }, async (tx) => {
  await tx.update(schema.brands).set({ name: 'Acme' }).where(eq(schema.brands.id, brandId));
  await appendAudit(tx, { actorType: 'staff', actorId: staffId, action: 'brand.renamed',
    targetType: 'brand', targetId: brandId, outcome: 'success' });
});
```

Public identifiers are TypeIDs (`conv_01j9…`). The database stores UUIDv7: use `toPublicId()` and
`fromPublicId()` at the API edge.

## Migrations

```bash
pnpm db:generate            # after editing src/schema: generates SQL + snapshot
pnpm db:custom --name=x     # hand-written SQL (functions, grants, partitioning)
pnpm db:migrate             # apply as DATABASE_OWNER_URL
```

A migration that adds tables must end with `SELECT app.harden_tenant_tables();`. The tests
enforce the rest:

- the unit drift test fails when `src/schema` changed without a migration;
- the integration drift test fails when the migrated catalog differs from what `src/schema`
  describes;
- the RLS suite fails when a new table is missing its policy, forced RLS or seed data.

## Customer memory

`src/schema/memory.ts` holds governed customer memory (release L):

- `learning_consents`: every memory choice, append-only (no updates or deletes for the app role).
- `memory_records`: the typed envelope. Content never changes after a write; a correction is a new
  record that supersedes the old one (trigger `memory_records_guard`). One current value per slot.
- `memory_embeddings`: vectors for recall, deleted with their record.
- `memory_deletions`: receipts; they complete once caches are purged and nothing is left.
- `deletion_tombstones`: content-free, append-only. The trigger `memory_records_tombstone_guard`
  refuses to write a deleted record again, or anything observed before a customer's erasure.

**Restores.** Tombstones live in this database. After restoring a backup, run
`SELECT app.apply_memory_tombstones();` (the worker also runs it daily). A restore to a point
before a deletion loses that deletion's tombstone too, so the restore procedure must carry the
tombstones of later deletions across (export them before restoring, insert them after).

## Decisions, language and cache tables

| File | Tables |
|---|---|
| `src/schema/decisions.ts` | `team_routing` (per inbox team and brand: intents, languages, reviewed translation languages, default, accepting; a team routes only for brands of its workspace), `decision_rubrics` (versioned questions and thresholds; published versions are immutable), `decision_tasks` (off, shadow or live per brand), `decision_records` (append-only except applying and reviewing; no delete for the application role) |
| `src/schema/language.ts` | `language_preferences`: interface locale, explicit reply language, last detection, one-time prompt, script, style and time zone per customer principal |
| `src/schema/cache.ts` | `cache_policies`, `cache_dependency_versions`, `cache_entry_index` (fingerprints and references, never content), `cache_metrics_daily` (counts only) |

Triggers raise `cache_dependency_versions` in the same transaction as the change: a knowledge
source's status, visibility or review cycle, a document's current version, status, title, URL or
source, an agent's published version and a brand's name. `test/decisions.int.test.ts` covers the
rubric and record guards and the triggers, including rollback and tenant isolation.

## Enterprise identity and platform operations

| File | Tables |
|---|---|
| `src/schema/sso.ts` | `sso_domains` (a workspace's email domains and their DNS proof; a partial unique index across tenants lets only one workspace hold a domain verified), `sso_connections` (one OpenID Connect connection per verified domain; the client secret is a reference into the secret broker) |
| `src/schema/operators.ts` | Global platform tables, on the allowlist in `test/rls.int.test.ts` with their reason: `platform_operators` (named by the server administrator), `platform_incidents` (banners every workspace sees) and `platform_audit_events` with `platform_audit_head` (the platform's own hash chain, append-only, secrets redacted when written) |
| `src/schema/identity.ts` | `support_grants` (requests, decisions and the time box of support access, A18) and `role_definitions.archived_at` |

The application role has no access to the platform tables; the gateway reads them, and the
incidents behind workspace banners, as `hamnivo_platform`. That role reads tenant metadata through
column grants, never content. Besides its own tables it may only ask for support access (a pending
`support_grants` row) and end a session early.
`setPlatformOperator()` runs as the owner, and `pnpm --filter @hamnivo/db platform:operator
<email> <role|--disable>` calls it from the command line (`node dist/main.operator.js` in the
gateway image).

## Tests

```bash
pnpm --filter @hamnivo/db test        # unit: IDs, audit hashing, schema drift
pnpm --filter @hamnivo/db test:int    # PostgreSQL: RLS on every table, roles, audit, resolvers
```

Integration tests clone a migrated template database per file, so they are fast and isolated.
`pnpm ci:local` runs them on throwaway PostgreSQL 16 and 18 containers.
