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
| Pre-tenant lookups | Only through `app.resolve_*` SECURITY DEFINER functions: widget public id, API key prefix, webhook connection, widget session, staff memberships and tenant slug. Each has a pinned `search_path`, column-level grants and no PUBLIC execute. |
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

## Tests

```bash
pnpm --filter @hamnivo/db test        # unit: IDs, audit hashing, schema drift
pnpm --filter @hamnivo/db test:int    # PostgreSQL: RLS on every table, roles, audit, resolvers
```

Integration tests clone a migrated template database per file, so they are fast and isolated.
`pnpm ci:local` runs them on throwaway PostgreSQL 16 and 18 containers.
