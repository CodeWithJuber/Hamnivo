import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, purgeAutomationRuns, schema, withTenant } from '../src/index.js';
import { type SeededTenant, seedTenant } from '../src/testing/index.js';
import { type Harness, openHarness } from './helpers.js';

/**
 * The move of W19's proactive prompts into website automations (G21). The database is fully
 * migrated already, so this puts back what a brand had before (its prompts, a custom role that
 * could edit them) and runs the data migration's statements again, as the owner does.
 */
const MIGRATION = new URL('../migrations/20261009114014_automations_data.sql', import.meta.url);

let h: Harness;
let a: SeededTenant;
let roleId: string;

beforeAll(async () => {
  h = await openHarness();
  a = await seedTenant(h.app, 'prompts');
  roleId = newId();
  await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
    await tx
      .update(schema.brandWidgetSettings)
      .set({
        proactive: {
          enabled: true,
          onlyWhenAvailable: true,
          maxPerDay: 2,
          dismissHours: 12,
          triggers: [
            {
              id: 'pricing',
              kind: 'page_path',
              path: '/pricing',
              seconds: 5,
              visits: null,
              message: { en: 'Questions about plans?', ar: 'أسئلة عن الباقات؟' },
            },
            {
              id: 'back',
              kind: 'returning_visitor',
              path: null,
              seconds: 0,
              visits: 3,
              message: { en: 'Welcome back!' },
            },
            {
              id: 'linger',
              kind: 'time_on_page',
              path: null,
              seconds: 30,
              visits: null,
              message: { en: 'Need a hand?' },
            },
          ],
        },
      })
      .where(eq(schema.brandWidgetSettings.brandId, a.brandId));
    await tx.insert(schema.roleDefinitions).values({
      id: roleId,
      tenantId: a.tenantId,
      key: `prompts_${randomBytes(3).toString('hex')}`,
      name: 'Prompt editor',
      permissions: ['conversations.read', 'widget.proactive'],
    });
  });
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean)
    // The data part only: the retention function after it exists already.
    .filter((statement) => !/automation_runs|FUNCTION/.test(statement));
  await h.owner.transaction(async (tx) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
});

afterAll(async () => {
  await h?.close();
});

describe('proactive prompts become website automations (G21)', () => {
  it('publishes one website rule per prompt, on as the prompts were', async () => {
    const rows = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx
        .select({ automation: schema.automations, version: schema.automationVersions })
        .from(schema.automations)
        .innerJoin(
          schema.automationVersions,
          eq(schema.automationVersions.id, schema.automations.publishedVersionId),
        )
        .where(
          and(eq(schema.automations.brandId, a.brandId), eq(schema.automations.kind, 'visitor')),
        )
        .orderBy(schema.automations.name),
    );
    expect(rows.map((r) => r.automation.name)).toEqual([
      'Website prompt: back',
      'Website prompt: linger',
      'Website prompt: pricing',
    ]);
    for (const { automation, version } of rows) {
      expect(automation.enabled).toBe(true);
      expect(automation.draft).toEqual(version.definition);
      expect(version).toMatchObject({ version: 1, publishedBy: null });
    }
    const definition = (name: string) =>
      rows.find((r) => r.automation.name === name)?.version.definition;
    const hours = { field: 'hours_open', op: 'is', value: true };
    expect(definition('Website prompt: pricing')).toEqual({
      event: { type: 'page_view', seconds: 5 },
      match: 'all',
      conditions: [{ field: 'page_url', op: 'starts_with', value: '/pricing' }, hours],
      actions: [
        {
          type: 'show_prompt',
          message: { en: 'Questions about plans?', ar: 'أسئلة عن الباقات؟' },
        },
      ],
    });
    expect(definition('Website prompt: back')).toMatchObject({
      event: { type: 'page_view', seconds: 0 },
      conditions: [{ field: 'visit_count', op: 'at_least', value: 3 }, hours],
    });
    expect(definition('Website prompt: linger')).toMatchObject({
      event: { type: 'page_view', seconds: 30 },
      conditions: [hours],
    });
  });

  it('keeps only the limits on the brand', async () => {
    const [row] = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx
        .select({ proactive: schema.brandWidgetSettings.proactive })
        .from(schema.brandWidgetSettings)
        .where(eq(schema.brandWidgetSettings.brandId, a.brandId)),
    );
    expect(row?.proactive).toEqual({ maxPerDay: 2, dismissHours: 12 });
  });

  it('lets custom roles that edited prompts manage automations instead', async () => {
    const [role] = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select().from(schema.roleDefinitions).where(eq(schema.roleDefinitions.id, roleId)),
    );
    expect(role?.permissions).toEqual([
      'conversations.read',
      'automations.read',
      'automations.manage',
    ]);
    expect(role?.version).toBe(2);
  });

  it('forces row-level security again on the tables it read', async () => {
    const { rows } = await h.owner.execute<{ relname: string; relforcerowsecurity: boolean }>(
      sql`select relname, relforcerowsecurity from pg_class
          where relname in ('brand_widget_settings', 'role_definitions', 'automations',
                            'automation_versions', 'automation_runs')
          order by relname`,
    );
    expect(rows.every((r) => r.relforcerowsecurity)).toBe(true);
    expect(rows).toHaveLength(5);
  });
});

describe('automation run retention (G21)', () => {
  it('removes runs after 90 days and keeps the recent ones', async () => {
    const old = new Date(Date.now() - 100 * 86_400_000);
    await withTenant(h.app, { tenantId: a.tenantId }, async (tx) => {
      const [run] = await tx.select().from(schema.automationRuns).limit(1);
      if (!run) throw new Error('the fixture has a run');
      await tx.insert(schema.automationRuns).values({
        ...run,
        id: newId(),
        eventKey: 'chat_closed',
        event: 'chat_closed',
        ranAt: old,
      });
    });
    expect(await purgeAutomationRuns(h.app)).toBeGreaterThanOrEqual(1);
    const left = await withTenant(h.app, { tenantId: a.tenantId }, (tx) =>
      tx.select({ ranAt: schema.automationRuns.ranAt }).from(schema.automationRuns),
    );
    expect(left.length).toBeGreaterThanOrEqual(1);
    expect(left.every((r) => r.ranAt.getTime() > old.getTime())).toBe(true);
  });
});
