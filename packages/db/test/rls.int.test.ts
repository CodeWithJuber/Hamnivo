import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendPlatformAudit,
  OperatorAccountMissingError,
  platformOperatorCommand,
  resolveSsoDomain,
  resolveSsoProvider,
  setPlatformOperator,
  type TenantTx,
  verifyPlatformAuditChain,
  withTenant,
} from '../src/index.js';
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

/**
 * Global platform tables (A17), each with the reason it is not tenant data. They keep forced
 * row-level security but have no tenant policy: the application role has no access at all, and
 * the platform role only what the security migration grants. Adding a table here needs a reason.
 */
const GLOBAL_TABLES: Record<string, string> = {
  platform_operators:
    'Hamnivo staff allowed into the platform console; named by the server administrator',
  platform_audit_events:
    'What platform operators did; each tenant’s share is also in its own audit log',
  platform_audit_head: 'Head of the platform audit hash chain',
  platform_incidents: 'Service incidents, shown to every workspace',
  plans:
    'Plans are defined by the platform operator for every workspace; a workspace keeps a copy of its plan’s limits in tenant_entitlements',
  invoices:
    'Invoices are the platform operator’s billing records; a workspace reads its own through app.tenant_invoices() and cannot change them',
};

/** Tables the application role may only insert into. */
const APPEND_ONLY = new Set([
  'audit_events',
  'operation_receipts',
  'decision_checks',
  'learning_consents',
  'deletion_tombstones',
  'webhook_events',
  'webhook_attempts',
  'usage_alerts',
  'customer_notifications',
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
  'webhook_deliveries',
  'conversation_metrics',
  'tenant_entitlements',
  'egress_policies',
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

const allTables = () => tables.filter((t) => !t.isPartition);
const tenantTables = () => allTables().filter((t) => !Object.hasOwn(GLOBAL_TABLES, t.name));

describe('catalog', () => {
  it('scopes every table to a tenant, except the listed global platform tables', () => {
    const unscoped = tenantTables().filter((t) => !t.hasTenantId && t.name !== 'tenants');
    expect(unscoped.map((t) => t.name)).toEqual([]);
    for (const [name, reason] of Object.entries(GLOBAL_TABLES)) {
      expect(
        allTables().map((t) => t.name),
        `${name} is listed but missing`,
      ).toContain(name);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('enables and forces row-level security on every table', () => {
    const weak = allTables().filter((t) => !t.rowSecurity || !t.forceRowSecurity);
    expect(weak.map((t) => t.name)).toEqual([]);
  });

  it('keeps the global platform tables away from the application role', async () => {
    const { rows } = await h.owner.execute<{ name: string; privileges: boolean; policy: string }>(
      sql`select c.relname as name,
                 has_table_privilege('hamnivo_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE') as privileges,
                 coalesce((select string_agg(p.policyname, ',') from pg_policies p
                           where p.tablename = c.relname and 'hamnivo_app' = any(p.roles)), '') as policy
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname in ${Object.keys(GLOBAL_TABLES)}`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(GLOBAL_TABLES).sort());
    for (const row of rows) {
      expect(row, row.name).toMatchObject({ privileges: false, policy: '' });
      await expectPgError(h.app.execute(sql`select * from ${sql.identifier(row.name)}`), '42501');
    }
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
    'brand_widget_settings',
    'widget_uploads',
    'conversation_read_state',
    'customer_notification_preferences',
    'customer_notifications',
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
    'migration_jobs',
    'migration_files',
    'migration_items',
    'external_id_mappings',
    'reconciliation_reports',
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
    'staff_inbox_preferences',
    'staff_conversation_reads',
    'brand_visitor_settings',
    'visitors',
    'visitor_sessions',
    'visitor_page_views',
    'sso_domains',
    'sso_connections',
    'team_routing',
    'decision_rubrics',
    'decision_tasks',
    'decision_records',
    'decision_checks',
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
    'webhook_endpoints',
    'webhook_events',
    'webhook_deliveries',
    'webhook_attempts',
    'egress_policies',
    'tenant_entitlements',
    'usage_alerts',
    'conversation_metrics',
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

    // The audit log, operation receipts, decision checks, consent decisions and deletion
    // tombstones are append-only; kill switches are cleared, deletion receipts completed, decision
    // records reviewed and financial records change state, but none of them is ever deleted.
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
      'brand_widget_settings',
      'widget_uploads',
      'conversation_read_state',
      'customer_notification_preferences',
      'customer_notifications',
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
      'migration_jobs',
      'migration_files',
      'migration_items',
      'external_id_mappings',
      'reconciliation_reports',
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
      'staff_inbox_preferences',
      'staff_conversation_reads',
      'brand_visitor_settings',
      'visitors',
      'visitor_sessions',
      'visitor_page_views',
      'sso_domains',
      'sso_connections',
      'team_routing',
      'decision_rubrics',
      'decision_tasks',
      'decision_records',
      'decision_checks',
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
      'webhook_endpoints',
      'webhook_events',
      'webhook_deliveries',
      'webhook_attempts',
      'egress_policies',
      'tenant_entitlements',
      'usage_alerts',
      'conversation_metrics',
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

  it('sees where AI is stopped and which providers are on, never reasons, labels or keys', async () => {
    const stops = await h.platform.execute<{ n: string }>(
      sql`select count(*) as n from kill_switches where tenant_id = ${a.tenantId}::uuid and scope is not null`,
    );
    expect(Number(stops.rows[0]?.n)).toBeGreaterThan(0);
    await expectPgError(h.platform.execute(sql`select reason from kill_switches`), '42501');
    await h.platform.execute(sql`select provider, status from model_connections`);
    await expectPgError(h.platform.execute(sql`select label from model_connections`), '42501');
    await expectPgError(
      h.platform.execute(sql`select api_key_secret_id from model_connections`),
      '42501',
    );
    await h.platform.execute(sql`select created_at, processed_at from outbox_events`);
    await expectPgError(h.platform.execute(sql`select payload from outbox_events`), '42501');
    await expectPgError(h.platform.execute(sql`select * from sso_connections`), '42501');
    await expectPgError(h.platform.execute(sql`select * from staff_members`), '42501');
  });

  it('may ask for support access and end it early, but never approve it', async () => {
    const request = (status: string, approvedBy: string | null) =>
      h.platform.execute(sql`
        insert into support_grants (id, tenant_id, platform_user_id, status, approved_by, decided_at,
                                    scopes, reason, expires_at)
        values (gen_random_uuid(), ${a.tenantId}::uuid, 'op', ${status}, ${approvedBy}::uuid,
                ${approvedBy ? sql`now()` : sql`null`}, '{configuration}', 'Ticket 7',
                now() + interval '30 minutes')`);
    await request('pending', null);
    await expectPgError(request('approved', a.staffMemberId), '42501');
    await expectPgError(
      h.platform.execute(sql`update support_grants set status = 'approved'`),
      '42501',
    );
    await expectPgError(
      h.platform.execute(sql`update support_grants set expires_at = now() + interval '1 day'`),
      '42501',
    );
    const ended = await h.platform.execute(
      sql`update support_grants set ended_at = now() where tenant_id = ${a.tenantId}::uuid and status = 'approved'`,
    );
    expect(ended.rowCount).toBe(1);
    await expectPgError(h.platform.execute(sql`delete from support_grants`), '42501');
  });

  it('reads operators, appends to its audit chain and cannot rewrite either', async () => {
    await h.platform.execute(sql`select * from platform_operators`);
    await expectPgError(
      h.platform.execute(sql`
        insert into platform_operators (id, auth_user_id, display_name, email, role)
        values (gen_random_uuid(), 'x', 'Mallory', 'm@example.com', 'platform_admin')`),
      '42501',
    );
    await h.platform.transaction((tx) =>
      appendPlatformAudit(tx, { operatorId: null, action: 'platform.checked', outcome: 'success' }),
    );
    await h.platform.transaction((tx) =>
      appendPlatformAudit(tx, {
        operatorId: null,
        action: 'support.requested',
        tenantId: a.tenantId,
        outcome: 'success',
        data: { scopes: ['audit'], clientSecret: 'hunter2' },
      }),
    );
    expect(await h.platform.transaction((tx) => verifyPlatformAuditChain(tx))).toEqual({
      ok: true,
      checked: 2,
      lastSeq: 2,
    });
    const stored = await h.platform.execute<{ data: Record<string, unknown> }>(
      sql`select data from platform_audit_events where seq = 2`,
    );
    expect(stored.rows[0]?.data).toEqual({ scopes: ['audit'], clientSecret: '[redacted]' });
    await expectPgError(
      h.platform.execute(sql`update platform_audit_events set action = 'x'`),
      '42501',
    );
    await expectPgError(h.platform.execute(sql`delete from platform_audit_events`), '42501');
    // The owner (the server administrator) names operators, and that is recorded in the chain.
    await expect(
      setPlatformOperator(h.owner, { email: 'omar@example.com', role: 'support_operator' }),
    ).rejects.toBeInstanceOf(OperatorAccountMissingError);
    await h.owner.execute(sql`
      insert into auth."user" (id, name, email, email_verified)
      values ('user_op', 'Omar Operator', 'omar@example.com', true)`);
    const named = await setPlatformOperator(h.owner, {
      email: 'OMAR@example.com',
      role: 'support_operator',
    });
    expect(named).toMatchObject({ role: 'support_operator', status: 'active' });
    expect(
      await setPlatformOperator(h.owner, { email: 'omar@example.com', disable: true }),
    ).toEqual({ id: named.id, role: 'support_operator', status: 'disabled' });
    const operators = await h.platform.execute<{ status: string }>(
      sql`select status from platform_operators`,
    );
    expect(operators.rows).toEqual([{ status: 'disabled' }]);
    const actions = await h.platform.execute<{ action: string }>(
      sql`select action from platform_audit_events order by seq`,
    );
    expect(actions.rows.map((r) => r.action)).toEqual([
      'platform.checked',
      'support.requested',
      'operator.appointed',
      'operator.disabled',
    ]);
    expect(await h.platform.transaction((tx) => verifyPlatformAuditChain(tx))).toMatchObject({
      ok: true,
      lastSeq: 4,
    });
  });

  it('names operators from the command line, as the server administrator does', async () => {
    const lines: string[] = [];
    const out = {
      log: (line: string) => lines.push(`log ${line}`),
      error: (line: string) => lines.push(`error ${line}`),
    };
    const run = (args: string[]) => platformOperatorCommand(args, h.database.owner, out);
    expect(await run(['nadia@example.com', 'root'])).toBe(1);
    expect(await platformOperatorCommand(['nadia@example.com', 'platform_viewer'], '', out)).toBe(
      1,
    );
    expect(await run(['nadia@example.com', 'platform_viewer'])).toBe(1);
    await h.owner.execute(sql`
      insert into auth."user" (id, name, email, email_verified)
      values ('user_cli', 'Nadia Viewer', 'nadia@example.com', true)`);
    expect(await run(['nadia@example.com', 'platform_viewer'])).toBe(0);
    expect(await run(['nadia@example.com', '--disable'])).toBe(0);
    expect(lines).toEqual([
      'error Usage: <email> <platform_admin|support_operator|platform_viewer|--disable>',
      'error DATABASE_OWNER_URL is not set.',
      expect.stringMatching(/^error No Hamnivo account uses nadia@example\.com\./),
      'log [hamnivo] nadia@example.com: active, platform_viewer',
      'log [hamnivo] nadia@example.com: disabled, platform_viewer',
    ]);
    const stored = await h.owner.execute<{ role: string; status: string }>(
      sql`select role, status from platform_operators where email = 'nadia@example.com'`,
    );
    expect(stored.rows).toEqual([{ role: 'platform_viewer', status: 'disabled' }]);
  });
});

describe('single sign-on domains', () => {
  it('lets only one workspace prove a domain, whatever each one can see', async () => {
    const domain = `claimed-${randomBytes(3).toString('hex')}.example`;
    const claim = (tenant: SeededTenant, verified: boolean) =>
      withTenant(h.app, { tenantId: tenant.tenantId }, (tx) =>
        tx.execute(sql`
          insert into sso_domains (id, tenant_id, domain, verification_token, verified_at)
          values (gen_random_uuid(), ${tenant.tenantId}::uuid, ${domain}, 'token',
                  ${verified ? sql`now()` : sql`null`})`),
      );
    await claim(a, true);
    // Another workspace may start a claim, but can never hold it verified too.
    await claim(b, false);
    await expectPgError(
      withTenant(h.app, { tenantId: b.tenantId }, (tx) =>
        tx.execute(sql`update sso_domains set verified_at = now() where domain = ${domain}`),
      ),
      '23505',
    );
    await expectPgError(claim(b, true), '23505');
    // Resolution needs a verified domain with a connection; this one has none yet.
    expect(await resolveSsoDomain(h.app, domain)).toBeNull();
    const seeded = await resolveSsoDomain(h.app, `${a.slug}.EXAMPLE`);
    expect(seeded).toMatchObject({ tenantId: a.tenantId, connectionStatus: 'active' });
    expect(await resolveSsoProvider(h.app, seeded?.providerId ?? '')).toMatchObject({
      tenantId: a.tenantId,
      domain: `${a.slug}.example`,
    });
    await expectPgError(
      withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
        tx.execute(sql`
          insert into sso_domains (id, tenant_id, domain, verification_token)
          values (gen_random_uuid(), ${a.tenantId}::uuid, 'Upper.Example', 'token')`),
      ),
      '23514',
    );
  });
});
