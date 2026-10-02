import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantTx, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { expectPgError, type Harness, openHarness } from './helpers.js';

interface CatalogTable {
  name: string;
  hasTenantId: boolean;
  rowSecurity: boolean;
  forceRowSecurity: boolean;
  isPartition: boolean;
  appSelect: boolean;
}

let h: Harness;
let a: SeededTenant;
let b: SeededTenant;
let tables: CatalogTable[];

const tenantColumn = (table: string) => (table === 'tenants' ? 'id' : 'tenant_id');

/** Tables the application role may only insert into. */
const APPEND_ONLY = new Set([
  'audit_events',
  'operation_receipts',
  'learning_consents',
  'deletion_tombstones',
  'action_approvals',
  'handoff_packets',
]);
/** Tables whose rows the application role never deletes. */
const NEVER_DELETED = new Set([
  'kill_switches',
  'memory_deletions',
  'decision_records',
  'operations',
  'merchant_connections',
  'quotes',
  'purchase_intents',
  'payments',
  'orders',
  'fulfillments',
  'refunds',
  'finance_exceptions',
  'commerce_events',
  'actions',
  'tool_definitions',
  'mcp_servers',
  'action_settings',
]);

/** Columns a copy can write (generated columns such as a tsvector are computed, not copied). */
async function writableColumns(table: string): Promise<string[]> {
  const { rows } = await h.owner.execute<{ name: string }>(sql`
    select attname as name from pg_attribute
    where attrelid = ${table}::regclass and attnum > 0 and not attisdropped and attgenerated = ''
    order by attnum`);
  return rows.map((r) => r.name);
}

/** `insert into <table> (…) select … from json_populate_record(…)` for a row sample. */
async function copyStatement(table: string, sample: unknown) {
  const columns = sql.join(
    (await writableColumns(table)).map((c) => sql.identifier(c)),
    sql`, `,
  );
  const t = sql.identifier(table);
  return sql`insert into ${t} (${columns}) select ${columns} from json_populate_record(null::${t}, ${JSON.stringify(sample)}::json)`;
}

async function count(tx: TenantTx, table: string, where?: ReturnType<typeof sql>) {
  const { rows } = await tx.execute<{ n: string }>(
    where
      ? sql`select count(*) as n from ${sql.identifier(table)} where ${where}`
      : sql`select count(*) as n from ${sql.identifier(table)}`,
  );
  return Number(rows[0]?.n);
}

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'alpha');
  b = await seedTenant(h.app, 'beta');
  const { rows } = await h.owner.execute<{
    name: string;
    has_tenant_id: boolean;
    row_security: boolean;
    force_row_security: boolean;
    is_partition: boolean;
    app_select: boolean;
  }>(sql`
    select c.relname as name,
           exists (select from pg_attribute at where at.attrelid = c.oid and at.attname = 'tenant_id' and not at.attisdropped) as has_tenant_id,
           c.relrowsecurity as row_security,
           c.relforcerowsecurity as force_row_security,
           c.relispartition as is_partition,
           has_table_privilege('hamnivo_app', c.oid, 'SELECT') as app_select
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname`);
  tables = rows.map((r) => ({
    name: r.name,
    hasTenantId: r.has_tenant_id,
    rowSecurity: r.row_security,
    forceRowSecurity: r.force_row_security,
    isPartition: r.is_partition,
    appSelect: r.app_select,
  }));
});

afterAll(async () => {
  await h?.close();
});

const tenantTables = () => tables.filter((t) => !t.isPartition);

describe('catalog', () => {
  it('scopes every table to a tenant', () => {
    const unscoped = tenantTables().filter((t) => !t.hasTenantId && t.name !== 'tenants');
    expect(unscoped.map((t) => t.name)).toEqual([]);
  });

  it('enables and forces row-level security on every table', () => {
    const weak = tenantTables().filter((t) => !t.rowSecurity || !t.forceRowSecurity);
    expect(weak.map((t) => t.name)).toEqual([]);
  });

  it('gives every table a tenant_isolation policy for the application role', async () => {
    const { rows } = await h.owner.execute<{ tablename: string; roles: string[]; qual: string }>(
      sql`select tablename, roles::text[] as roles, qual from pg_policies where schemaname = 'public' and policyname = 'tenant_isolation'`,
    );
    const byTable = new Map(rows.map((r) => [r.tablename, r]));
    for (const table of tenantTables()) {
      const policy = byTable.get(table.name);
      expect(policy, `${table.name} has no tenant_isolation policy`).toBeDefined();
      expect(policy?.roles).toEqual(['hamnivo_app']);
      expect(policy?.qual).toContain('current_tenant()');
    }
  });

  it('keeps partitions out of reach (their parent carries the policies)', () => {
    const partitions = tables.filter((t) => t.isPartition);
    expect(partitions.length).toBeGreaterThan(0);
    expect(partitions.filter((t) => t.appSelect).map((t) => t.name)).toEqual([]);
  });

  it('seeds every tenant table for both tenants', async () => {
    for (const tenant of [a, b]) {
      await withTenant(h.app, { tenantId: tenant.tenantId }, async (tx) => {
        for (const table of tenantTables()) {
          expect(await count(tx, table.name), `${table.name} is not seeded`).toBeGreaterThan(0);
        }
      });
    }
  });
});

describe('two-tenant isolation', () => {
  it.each([
    'tenants',
    'workspaces',
    'brands',
    'secrets',
    'brand_identity_keys',
    'staff_members',
    'role_definitions',
    'service_accounts',
    'grants',
    'invitations',
    'api_keys',
    'support_grants',
    'customer_principals',
    'widget_sessions',
    'identity_nonces',
    'authority_connections',
    'authority_inboxes',
    'authority_bots',
    'authority_contacts',
    'staff_authority_links',
    'conversation_controls',
    'message_ledger',
    'publications',
    'conversation_feedback',
    'integration_inbox',
    'conversation_journal',
    'reconcile_cursors',
    'outbox_events',
    'processed_events',
    'idempotency_keys',
    'usage_entries',
    'model_connections',
    'agent_profiles',
    'agent_versions',
    'kill_switches',
    'runs',
    'run_steps',
    'knowledge_sources',
    'knowledge_documents',
    'document_versions',
    'knowledge_chunks',
    'learning_consents',
    'memory_records',
    'memory_embeddings',
    'memory_deletions',
    'deletion_tombstones',
    'teams',
    'team_members',
    'team_authority_links',
    'conversation_inbox_state',
    'staff_drafts',
    'conversation_links',
    'conversation_reviews',
    'team_routing',
    'decision_rubrics',
    'decision_tasks',
    'decision_records',
    'language_preferences',
    'cache_policies',
    'cache_dependency_versions',
    'cache_entry_index',
    'cache_metrics_daily',
    'operations',
    'operation_receipts',
    'merchant_connections',
    'catalog_snapshots',
    'carts',
    'quotes',
    'purchase_intents',
    'payments',
    'orders',
    'fulfillments',
    'refunds',
    'finance_exceptions',
    'commerce_events',
    'mcp_servers',
    'tool_definitions',
    'action_settings',
    'actions',
    'action_approvals',
    'handoff_packets',
    'simulation_suites',
    'simulation_runs',
    'audit_heads',
    'audit_events',
  ])('%s: reads, writes and moves stay inside the tenant', async (table) => {
    expect(tenantTables().map((t) => t.name)).toContain(table);
    const column = sql.identifier(tenantColumn(table));
    const t = sql.identifier(table);

    // Reads: tenant A sees only its own rows.
    await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
      expect(await count(tx, table, sql`${column} = ${b.tenantId}::uuid`)).toBe(0);
      expect(await count(tx, table)).toBe(
        await count(tx, table, sql`${column} = ${a.tenantId}::uuid`),
      );
    });

    // The audit log, operation receipts, consent decisions and deletion tombstones are append-only;
    // kill switches are cleared, deletion receipts completed, decision records reviewed and
    // financial records change state, but none of them is ever deleted.
    const updatable = !APPEND_ONLY.has(table);
    const deletable = updatable && !NEVER_DELETED.has(table);
    if (updatable) {
      // Updates and deletes aimed at tenant B affect nothing.
      await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
        const updated = await tx.execute(
          sql`update ${t} set ${column} = ${column} where ${column} = ${b.tenantId}::uuid`,
        );
        expect(updated.rowCount).toBe(0);
        if (deletable) {
          const deleted = await tx.execute(
            sql`delete from ${t} where ${column} = ${b.tenantId}::uuid`,
          );
          expect(deleted.rowCount).toBe(0);
        }
      });
    }

    // Inserting a copy of one of B's rows while acting as A violates the policy.
    const sample = await withTenant(h.app, { tenantId: b.tenantId }, async (tx) => {
      const { rows } = await tx.execute<{ row: Record<string, unknown> }>(
        sql`select row_to_json(x) as row from ${t} x limit 1`,
      );
      return rows[0]?.row;
    });
    expect(sample).toBeDefined();
    const copy = await copyStatement(table, sample);
    await expectPgError(
      withTenant(h.app, { tenantId: a.tenantId }, (tx) => tx.execute(copy)),
      '42501',
    );

    // Moving A's rows to B is rejected (audit rows cannot be updated at all). Published agent
    // versions are immutable before RLS is even consulted, so the draft is the row moved.
    const movable = table === 'agent_versions' ? sql` and state = 'draft'` : sql``;
    await expectPgError(
      withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
        tx.execute(
          sql`update ${t} set ${column} = ${b.tenantId}::uuid where ${column} = ${a.tenantId}::uuid${movable}`,
        ),
      ),
      '42501',
    );

    // Without a tenant, nothing is visible and nothing can be written.
    const { rows } = await h.app.execute<{ n: string }>(sql`select count(*) as n from ${t}`);
    expect(Number(rows[0]?.n)).toBe(0);
    await expectPgError(h.app.execute(copy), '42501');
  });

  it('covers every tenant table in the isolation matrix', () => {
    // Guard: adding a table without adding it to the list above (and to seedTenant) fails here.
    const listed = new Set([
      'tenants',
      'workspaces',
      'brands',
      'secrets',
      'brand_identity_keys',
      'staff_members',
      'role_definitions',
      'service_accounts',
      'grants',
      'invitations',
      'api_keys',
      'support_grants',
      'customer_principals',
      'widget_sessions',
      'identity_nonces',
      'authority_connections',
      'authority_inboxes',
      'authority_bots',
      'authority_contacts',
      'staff_authority_links',
      'conversation_controls',
      'message_ledger',
      'publications',
      'conversation_feedback',
      'integration_inbox',
      'conversation_journal',
      'reconcile_cursors',
      'outbox_events',
      'processed_events',
      'idempotency_keys',
      'usage_entries',
      'model_connections',
      'agent_profiles',
      'agent_versions',
      'kill_switches',
      'runs',
      'run_steps',
      'knowledge_sources',
      'knowledge_documents',
      'document_versions',
      'knowledge_chunks',
      'learning_consents',
      'memory_records',
      'memory_embeddings',
      'memory_deletions',
      'deletion_tombstones',
      'teams',
      'team_members',
      'team_authority_links',
      'conversation_inbox_state',
      'staff_drafts',
      'conversation_links',
      'conversation_reviews',
      'team_routing',
      'decision_rubrics',
      'decision_tasks',
      'decision_records',
      'language_preferences',
      'cache_policies',
      'cache_dependency_versions',
      'cache_entry_index',
      'cache_metrics_daily',
      'operations',
      'operation_receipts',
      'merchant_connections',
      'catalog_snapshots',
      'carts',
      'quotes',
      'purchase_intents',
      'payments',
      'orders',
      'fulfillments',
      'refunds',
      'finance_exceptions',
      'commerce_events',
      'mcp_servers',
      'tool_definitions',
      'action_settings',
      'actions',
      'action_approvals',
      'handoff_packets',
      'simulation_suites',
      'simulation_runs',
      'audit_heads',
      'audit_events',
    ]);
    expect(
      tenantTables()
        .map((t) => t.name)
        .filter((name) => !listed.has(name)),
    ).toEqual([]);
  });
});

describe('platform role', () => {
  it('reads tenant metadata across tenants but no tenant data', async () => {
    const { rows } = await h.platform.execute<{ n: string }>(
      sql`select count(*) as n from tenants where id in (${a.tenantId}::uuid, ${b.tenantId}::uuid)`,
    );
    expect(Number(rows[0]?.n)).toBe(2);
    await expectPgError(h.platform.execute(sql`select * from secrets`), '42501');
    await expectPgError(h.platform.execute(sql`select * from conversation_journal`), '42501');
    await expectPgError(h.platform.execute(sql`update tenants set name = 'x'`), '42501');
  });
});
