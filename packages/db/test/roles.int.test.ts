import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectPgError, type Harness, openHarness } from './helpers.js';

let h: Harness;

beforeAll(async () => {
  h = await openHarness();
});

afterAll(async () => {
  await h?.close();
});

describe('staff authentication tables', () => {
  it('are usable by the application role only', async () => {
    const { rows } = await h.app.execute<{ n: string }>(sql`select count(*) as n from auth.user`);
    expect(Number(rows[0]?.n)).toBe(0);
    await expectPgError(h.platform.execute(sql`select * from auth.user`), '42501');
    await expectPgError(h.platform.execute(sql`select * from auth.session`), '42501');
  });
});

describe('database roles', () => {
  it('keeps the application and platform roles unprivileged', async () => {
    const { rows } = await h.owner.execute<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
    }>(sql`select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
           from pg_roles where rolname like 'hamnivo\_%' order by rolname`);
    const role = (name: string) => rows.find((r) => r.rolname === name);
    for (const name of ['hamnivo_app', 'hamnivo_platform']) {
      expect(role(name)).toMatchObject({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolcanlogin: true,
      });
    }
    expect(role('hamnivo_owner')).toMatchObject({ rolsuper: false, rolbypassrls: false });
    expect(role('hamnivo_resolver')).toMatchObject({ rolcanlogin: false, rolbypassrls: true });
  });

  it('lets the application role own nothing', async () => {
    const { rows } = await h.owner.execute<{ n: string }>(sql`
      select (select count(*) from pg_class where relowner = 'hamnivo_app'::regrole)
           + (select count(*) from pg_proc where proowner = 'hamnivo_app'::regrole)
           + (select count(*) from pg_namespace where nspowner = 'hamnivo_app'::regrole) as n`);
    expect(Number(rows[0]?.n)).toBe(0);
  });

  it('denies the application role any DDL or migration metadata', async () => {
    await expectPgError(h.app.execute(sql`create table public.intruder (id int)`), '42501');
    await expectPgError(h.app.execute(sql`create schema intruder`), '42501');
    await expectPgError(
      h.app.execute(sql`alter table tenants disable row level security`),
      '42501',
    );
    await expectPgError(h.app.execute(sql`select * from drizzle.__drizzle_migrations`), '42501');
    await expectPgError(h.app.execute(sql`select app.harden_tenant_tables()`), '42501');
  });

  it('exposes cross-tenant functions only as audited SECURITY DEFINER functions', async () => {
    const { rows } = await h.owner.execute<{
      fn: string;
      owner: string;
      secdef: boolean;
      config: string[] | null;
      public_exec: boolean;
      app_exec: boolean;
      platform_exec: boolean;
    }>(sql`
      select p.oid::regprocedure::text as fn,
             pg_get_userbyid(p.proowner) as owner,
             p.prosecdef as secdef,
             p.proconfig as config,
             exists (select from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec,
             has_function_privilege('hamnivo_app', p.oid, 'EXECUTE') as app_exec,
             has_function_privilege('hamnivo_platform', p.oid, 'EXECUTE') as platform_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app'
      order by 1`);
    const definers = rows.filter((r) => r.secdef);
    expect(definers.map((r) => r.fn).sort()).toEqual(
      [
        'app.apply_memory_tombstones()',
        'app.claim_commerce_events(integer,integer)',
        'app.claim_commerce_work(integer,integer)',
        'app.claim_integration_inbox(integer,integer)',
        'app.claim_outbox(integer,integer)',
        'app.claim_reconcile_cursors(integer,integer)',
        'app.claim_webhook_deliveries(integer,integer)',
        'app.ensure_audit_partitions(integer)',
        'app.ensure_reconcile_cursors()',
        'app.expired_actions(integer,timestamp with time zone)',
        'app.expired_memory_subjects(integer)',
        'app.purge_expired(integer)',
        'app.purge_migration_files(integer)',
        'app.purge_visitors(integer)',
        'app.purge_webhook_events(integer,integer)',
        'app.purge_widget_uploads(integer)',
        'app.resolve_api_key(text)',
        'app.resolve_authority_connection(uuid)',
        'app.resolve_invitation(uuid)',
        'app.resolve_merchant_connection(uuid)',
        'app.resolve_sso_domain(text)',
        'app.resolve_sso_provider(text)',
        'app.resolve_staff_memberships(text)',
        'app.resolve_tenant_slug(text)',
        'app.resolve_widget(text)',
        'app.resolve_widget_session(uuid)',
        'app.tenant_invoices(uuid)',
      ].sort(),
    );
    for (const fn of definers) {
      expect(fn.config, `${fn.fn} must pin search_path`).toContain(
        'search_path=pg_catalog, public',
      );
      expect(fn.public_exec, `${fn.fn} must not be executable by PUBLIC`).toBe(false);
      expect(fn.platform_exec, `${fn.fn} must not be executable by the platform role`).toBe(false);
      expect(fn.app_exec).toBe(true);
      expect(fn.owner).toBe(
        fn.fn.startsWith('app.ensure_audit_partitions') ? 'hamnivo_owner' : 'hamnivo_resolver',
      );
    }
    const harden = rows.find((r) => r.fn === 'app.harden_tenant_tables()');
    expect(harden?.app_exec).toBe(false);
  });
});
