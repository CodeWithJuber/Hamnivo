import {
  type Automation,
  type AutomationDefinition,
  type AutomationList,
  type AutomationOptions,
  type AutomationRunList,
  type AutomationVersionList,
  MAX_AUTOMATIONS_PER_BRAND,
  type PromptLimits,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { ActorCredential } from '@hamnivo/domain';
import {
  type DefinitionProblem,
  definitionProblems,
  kindOfEvent,
} from '@hamnivo/domain/automations';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gte, inArray, max } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { teamsForBrand } from '../decisions/team-routing.service.js';
import { enforce } from '../identity/staff.guard.js';
import { brandConnectionId } from '../migration/destination.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { brandSurface, saveSurface } from '../widget/settings.service.js';
import { storedDefinition } from './definitions.js';

type BrandRow = typeof schema.brands.$inferSelect;
type AutomationRow = typeof schema.automations.$inferSelect;
type VersionRow = typeof schema.automationVersions.$inferSelect;

const INTEGRATION: ActorCredential = { kind: 'integration' };
const WEEK_MS = 7 * 24 * 3_600_000;

/** What each problem means, for the field error people see next to it. */
const PROBLEM_TEXT: Record<DefinitionProblem['code'], string> = {
  field_not_allowed: 'This condition is not available for this kind of automation',
  action_not_allowed: 'This action is not available for this kind of automation',
  action_repeated: 'This action can only be used once',
  prompt_required: 'A website automation shows a prompt',
  message_needs_people:
    'A message is sent only while the AI does not have the chat: add the condition “Who has the chat is not the AI”, and match all conditions',
  message_after_close: 'A message cannot be sent after the chat closed',
  seconds_out_of_range: 'Choose a time this event allows',
};

const pathOf = (path: (string | number)[]) => ['definition', ...path].join('.');

/**
 * Automations (G21) for Studio and the admin API. Reading needs automations.read, changing
 * automations.manage, on the rule's brand. A rule is saved as a draft and runs once published;
 * each publication is kept as a version that can be restored. Changes are audited, and a change
 * to a website rule publishes a new widget configuration so the loader picks it up.
 */
@Injectable()
export class AutomationsService {
  private readonly logger = new Logger(AutomationsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private allow(principal: StaffPrincipal, permission: Permission, brand: BrandRow) {
    enforce(
      authorize(
        principal,
        permission,
        { workspaceId: brand.workspaceId, brandId: brand.id },
        {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        },
      ),
    );
  }

  /** The brand, once the caller may act on it; locked when it changes. */
  private async brand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
    permission: Permission,
    lock = false,
  ): Promise<BrandRow> {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const query = tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const [brand] = lock ? await query.for('update') : await query;
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    this.allow(principal, permission, brand);
    return brand;
  }

  /** The rule and its brand, once the caller may act on it; both locked when it changes. */
  private async automation(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
    lock = false,
  ): Promise<{ row: AutomationRow; brand: BrandRow }> {
    let id: string;
    try {
      id = fromPublicId('automation', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Automation not found.' });
    }
    const [found] = await tx
      .select({ brandId: schema.automations.brandId })
      .from(schema.automations)
      .where(eq(schema.automations.id, id));
    if (!found) throw new AppError('NOT_FOUND', { detail: 'Automation not found.' });
    // The brand first, then the rule: the same order every change takes.
    const brandQuery = tx.select().from(schema.brands).where(eq(schema.brands.id, found.brandId));
    const [brand] = lock ? await brandQuery.for('update') : await brandQuery;
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Automation not found.' });
    this.allow(principal, permission, brand);
    const query = tx.select().from(schema.automations).where(eq(schema.automations.id, id));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Automation not found.' });
    return { row, brand };
  }

  /** The brand's tags (lower case), or null when its chat account cannot be reached. */
  private async tagsOf(tenantId: string, brandId: string): Promise<string[] | null> {
    const connectionId = await withTenant(this.db, { tenantId }, (tx) =>
      brandConnectionId(tx, brandId),
    );
    if (!connectionId) return null;
    try {
      const runtime = await this.registry.get(tenantId, connectionId);
      return (await runtime.authority.listLabels(INTEGRATION)).map((l) => l.title.toLowerCase());
    } catch (error) {
      this.logger.warn(`tags not loaded for automations: ${String(error)}`);
      return null;
    }
  }

  /**
   * Refuses a definition that cannot run as written: the domain's problems, and teams or tags
   * the brand does not have. Tags are checked only when a rule adds one.
   */
  private async check(
    tx: TenantTx,
    principal: StaffPrincipal,
    brand: BrandRow,
    definition: AutomationDefinition,
  ): Promise<void> {
    const fields = definitionProblems(definition).map((problem) => ({
      path: pathOf(problem.path),
      message: PROBLEM_TEXT[problem.code],
    }));
    const teams = new Set(
      (await teamsForBrand(tx, brand)).map((r) => toPublicId('team', r.team.id)),
    );
    definition.actions.forEach((action, index) => {
      if (action.type === 'assign_team' && !teams.has(action.teamId)) {
        fields.push({
          path: pathOf(['actions', index, 'teamId']),
          message: 'Choose one of the brand’s support teams',
        });
      }
    });
    definition.conditions.forEach((condition, index) => {
      if (condition.field !== 'team') return;
      condition.value.forEach((team, at) => {
        if (!teams.has(team)) {
          fields.push({
            path: pathOf(['conditions', index, 'value', at]),
            message: 'Choose one of the brand’s support teams',
          });
        }
      });
    });
    const tagged = definition.actions.flatMap((action, index) =>
      action.type === 'add_tag' ? [{ tag: action.tag.toLowerCase(), index }] : [],
    );
    if (tagged.length > 0) {
      const tags = await this.tagsOf(principal.tenantId, brand.id);
      if (tags === null) {
        throw new AppError('AUTHORITY_UNAVAILABLE', {
          detail: 'The brand’s tags could not be loaded, so the tag cannot be checked. Try again.',
          retryable: true,
        });
      }
      for (const { tag, index } of tagged) {
        if (!tags.includes(tag)) {
          fields.push({
            path: pathOf(['actions', index, 'tag']),
            message: 'Choose one of the brand’s tags',
          });
        }
      }
    }
    if (fields.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This automation cannot run as written.',
        fields,
      });
    }
  }

  private async view(tx: TenantTx, row: AutomationRow): Promise<Automation> {
    const [one] = await this.views(tx, [row]);
    return one as Automation;
  }

  private async views(tx: TenantTx, rows: AutomationRow[]): Promise<Automation[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const versionIds = rows.flatMap((r) => (r.publishedVersionId ? [r.publishedVersionId] : []));
    const versions = versionIds.length
      ? await tx
          .select({ version: schema.automationVersions, name: schema.staffMembers.displayName })
          .from(schema.automationVersions)
          .leftJoin(
            schema.staffMembers,
            eq(schema.staffMembers.id, schema.automationVersions.publishedBy),
          )
          .where(inArray(schema.automationVersions.id, versionIds))
      : [];
    const byVersion = new Map(versions.map((v) => [v.version.id, v]));
    const since = new Date(this.clock().getTime() - WEEK_MS);
    const stats = await tx
      .select({
        automationId: schema.automationRuns.automationId,
        runs: count(),
        last: max(schema.automationRuns.ranAt),
      })
      .from(schema.automationRuns)
      .where(
        and(
          inArray(schema.automationRuns.automationId, ids),
          eq(schema.automationRuns.outcome, 'done'),
          gte(schema.automationRuns.ranAt, since),
        ),
      )
      .groupBy(schema.automationRuns.automationId);
    const lastEver = await tx
      .select({
        automationId: schema.automationRuns.automationId,
        last: max(schema.automationRuns.ranAt),
      })
      .from(schema.automationRuns)
      .where(
        and(
          inArray(schema.automationRuns.automationId, ids),
          eq(schema.automationRuns.outcome, 'done'),
        ),
      )
      .groupBy(schema.automationRuns.automationId);
    const weekly = new Map(stats.map((s) => [s.automationId, s.runs]));
    const latest = new Map(lastEver.map((s) => [s.automationId, s.last]));
    return rows.map((row) => {
      const draft = storedDefinition(row.draft) as AutomationDefinition;
      const published = row.publishedVersionId ? byVersion.get(row.publishedVersionId) : undefined;
      const definition = published ? storedDefinition(published.version.definition) : null;
      return {
        id: toPublicId('automation', row.id),
        brandId: toPublicId('brand', row.brandId),
        name: row.name,
        kind: row.kind,
        enabled: row.enabled,
        draft,
        revision: row.revision,
        published:
          published && definition
            ? {
                version: published.version.version,
                publishedAt: published.version.publishedAt.toISOString(),
                publishedBy: published.version.publishedBy
                  ? toPublicId('staff', published.version.publishedBy)
                  : null,
                publishedByName: published.name ?? null,
                definition,
              }
            : null,
        unpublishedChanges:
          !published ||
          published.version.name !== row.name ||
          JSON.stringify(published.version.definition) !== JSON.stringify(row.draft),
        stats: {
          runsThisWeek: weekly.get(row.id) ?? 0,
          lastRunAt: latest.get(row.id)?.toISOString() ?? null,
        },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private async audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    targetId: string,
    data: Record<string, unknown>,
  ) {
    await appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'automation',
      targetId,
      outcome: 'success',
      data,
    });
  }

  /** A website rule changed what visitors may see: the loader and widget pick up a new version. */
  private async republish(tx: TenantTx, brand: BrandRow, kind: AutomationRow['kind']) {
    if (kind !== 'visitor') return;
    await tx
      .update(schema.brands)
      .set({ configVersion: brand.configVersion + 1, updatedAt: this.clock() })
      .where(eq(schema.brands.id, brand.id));
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<AutomationList> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'automations.read');
      const rows = await tx
        .select()
        .from(schema.automations)
        .where(eq(schema.automations.brandId, brand.id))
        .orderBy(schema.automations.createdAt, schema.automations.id);
      const surface = await brandSurface(tx, brand.id);
      return {
        brandId: brandPublicId,
        items: await this.views(tx, rows),
        promptLimits: surface.promptLimits,
      };
    });
  }

  async options(principal: StaffPrincipal, brandPublicId: string): Promise<AutomationOptions> {
    const teams = await this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'automations.read');
      return {
        brandId: brand.id,
        teams: (await teamsForBrand(tx, brand)).map((r) => ({
          id: toPublicId('team', r.team.id),
          name: r.team.name,
        })),
      };
    });
    const tags = await this.tagsOf(principal.tenantId, teams.brandId);
    return { tags: tags ? [...new Set(tags)].sort() : null, teams: teams.teams };
  }

  async get(principal: StaffPrincipal, publicId: string): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const { row } = await this.automation(tx, principal, publicId, 'automations.read');
      return this.view(tx, row);
    });
  }

  async create(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: { name: string; definition: AutomationDefinition; publish: boolean },
  ): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'automations.manage', true);
      const [existing] = await tx
        .select({ n: count() })
        .from(schema.automations)
        .where(eq(schema.automations.brandId, brand.id));
      if ((existing?.n ?? 0) >= MAX_AUTOMATIONS_PER_BRAND) {
        throw new AppError('VALIDATION_FAILED', {
          detail: `A brand can have up to ${MAX_AUTOMATIONS_PER_BRAND} automations. Delete one you no longer use.`,
          reason: 'too_many_automations',
        });
      }
      // A draft may be unfinished; publishing checks it.
      if (input.publish) await this.check(tx, principal, brand, input.definition);
      const kind = kindOfEvent(input.definition.event.type);
      const now = this.clock();
      const [row] = await tx
        .insert(schema.automations)
        .values({
          id: newId(),
          tenantId: principal.tenantId,
          brandId: brand.id,
          name: input.name,
          kind,
          enabled: true,
          draft: input.definition,
          createdBy: principal.staffMemberId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const created = row as AutomationRow;
      const publicId = toPublicId('automation', created.id);
      await this.audit(tx, principal, 'automation.created', publicId, {
        brand: brandPublicId,
        name: input.name,
        kind,
        event: input.definition.event.type,
      });
      if (!input.publish) return this.view(tx, created);
      return this.view(tx, await this.publishRow(tx, principal, brand, created));
    });
  }

  async save(
    principal: StaffPrincipal,
    publicId: string,
    input: { name: string; definition: AutomationDefinition; revision: number },
  ): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const { row } = await this.automation(tx, principal, publicId, 'automations.manage', true);
      if (row.revision !== input.revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Someone saved this automation after you opened it. Reload to see their changes.',
        });
      }
      const kind = kindOfEvent(input.definition.event.type);
      if (kind !== row.kind) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'A website automation stays on the website, and a chat automation in chats.',
          fields: [{ path: 'definition.event.type', message: 'Choose an event of the same kind' }],
        });
      }
      const [saved] = await tx
        .update(schema.automations)
        .set({
          name: input.name,
          draft: input.definition,
          revision: row.revision + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.automations.id, row.id))
        .returning();
      await this.audit(tx, principal, 'automation.saved', publicId, {
        name: input.name,
        revision: row.revision + 1,
      });
      return this.view(tx, saved as AutomationRow);
    });
  }

  /** Publishes the row's draft as the next version; the caller holds the locks. */
  private async publishRow(
    tx: TenantTx,
    principal: StaffPrincipal,
    brand: BrandRow,
    row: AutomationRow,
  ): Promise<AutomationRow> {
    const definition = storedDefinition(row.draft);
    if (!definition) {
      throw new AppError('VALIDATION_FAILED', { detail: 'This draft can no longer be read.' });
    }
    await this.check(tx, principal, brand, definition);
    const [latest] = await tx
      .select({ version: max(schema.automationVersions.version) })
      .from(schema.automationVersions)
      .where(eq(schema.automationVersions.automationId, row.id));
    const version = (latest?.version ?? 0) + 1;
    const versionId = newId();
    const now = this.clock();
    await tx.insert(schema.automationVersions).values({
      id: versionId,
      tenantId: row.tenantId,
      automationId: row.id,
      version,
      name: row.name,
      definition,
      publishedBy: principal.staffMemberId,
      publishedAt: now,
    });
    const [published] = await tx
      .update(schema.automations)
      .set({ publishedVersionId: versionId, updatedAt: now })
      .where(eq(schema.automations.id, row.id))
      .returning();
    await this.republish(tx, brand, row.kind);
    await this.audit(tx, principal, 'automation.published', toPublicId('automation', row.id), {
      version,
      name: row.name,
      event: definition.event.type,
      actions: definition.actions.map((a) => a.type),
    });
    return published as AutomationRow;
  }

  async publish(
    principal: StaffPrincipal,
    publicId: string,
    revision: number,
  ): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const { row, brand } = await this.automation(
        tx,
        principal,
        publicId,
        'automations.manage',
        true,
      );
      if (row.revision !== revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'This automation changed after you opened it. Reload before publishing.',
        });
      }
      return this.view(tx, await this.publishRow(tx, principal, brand, row));
    });
  }

  async setEnabled(
    principal: StaffPrincipal,
    publicId: string,
    enabled: boolean,
  ): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const { row, brand } = await this.automation(
        tx,
        principal,
        publicId,
        'automations.manage',
        true,
      );
      if (row.enabled === enabled) return this.view(tx, row);
      const [changed] = await tx
        .update(schema.automations)
        .set({ enabled, updatedAt: this.clock() })
        .where(eq(schema.automations.id, row.id))
        .returning();
      await this.republish(tx, brand, row.kind);
      await this.audit(
        tx,
        principal,
        enabled ? 'automation.enabled' : 'automation.disabled',
        publicId,
        {
          name: row.name,
        },
      );
      return this.view(tx, changed as AutomationRow);
    });
  }

  async remove(principal: StaffPrincipal, publicId: string): Promise<void> {
    await this.tx(principal, async (tx) => {
      const { row, brand } = await this.automation(
        tx,
        principal,
        publicId,
        'automations.manage',
        true,
      );
      await tx.delete(schema.automations).where(eq(schema.automations.id, row.id));
      await this.republish(tx, brand, row.kind);
      await this.audit(tx, principal, 'automation.deleted', publicId, {
        name: row.name,
        kind: row.kind,
      });
    });
  }

  async versions(principal: StaffPrincipal, publicId: string): Promise<AutomationVersionList> {
    return this.tx(principal, async (tx) => {
      const { row } = await this.automation(tx, principal, publicId, 'automations.read');
      const rows = await tx
        .select({ version: schema.automationVersions, name: schema.staffMembers.displayName })
        .from(schema.automationVersions)
        .leftJoin(
          schema.staffMembers,
          eq(schema.staffMembers.id, schema.automationVersions.publishedBy),
        )
        .where(eq(schema.automationVersions.automationId, row.id))
        .orderBy(desc(schema.automationVersions.version));
      return {
        items: rows.flatMap(({ version, name }: { version: VersionRow; name: string | null }) => {
          const definition = storedDefinition(version.definition);
          return definition
            ? [
                {
                  version: version.version,
                  name: version.name,
                  definition,
                  publishedAt: version.publishedAt.toISOString(),
                  publishedBy: version.publishedBy
                    ? toPublicId('staff', version.publishedBy)
                    : null,
                  publishedByName: name,
                },
              ]
            : [];
        }),
      };
    });
  }

  /** Copies a published version into the draft; publishing it again is a separate step. */
  async restore(
    principal: StaffPrincipal,
    publicId: string,
    version: number,
    revision: number,
  ): Promise<Automation> {
    return this.tx(principal, async (tx) => {
      const { row } = await this.automation(tx, principal, publicId, 'automations.manage', true);
      if (row.revision !== revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'This automation changed after you opened it. Reload before restoring.',
        });
      }
      const [found] = await tx
        .select()
        .from(schema.automationVersions)
        .where(
          and(
            eq(schema.automationVersions.automationId, row.id),
            eq(schema.automationVersions.version, version),
          ),
        );
      if (!found) throw new AppError('NOT_FOUND', { detail: 'Version not found.' });
      const [restored] = await tx
        .update(schema.automations)
        .set({
          name: found.name,
          draft: found.definition,
          revision: row.revision + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.automations.id, row.id))
        .returning();
      await this.audit(tx, principal, 'automation.restored', publicId, { version });
      return this.view(tx, restored as AutomationRow);
    });
  }

  async runs(
    principal: StaffPrincipal,
    publicId: string,
    limit: number,
  ): Promise<AutomationRunList> {
    return this.tx(principal, async (tx) => {
      const { row } = await this.automation(tx, principal, publicId, 'automations.read');
      const rows = await tx
        .select({ run: schema.automationRuns, version: schema.automationVersions.version })
        .from(schema.automationRuns)
        .innerJoin(
          schema.automationVersions,
          eq(schema.automationVersions.id, schema.automationRuns.versionId),
        )
        .where(eq(schema.automationRuns.automationId, row.id))
        .orderBy(desc(schema.automationRuns.ranAt), desc(schema.automationRuns.id))
        .limit(limit);
      return {
        items: rows.map(({ run, version }) => ({
          id: toPublicId('automationRun', run.id),
          version,
          conversationId: toPublicId('conversation', run.conversationId),
          event: run.event as Automation['draft']['event']['type'],
          outcome: run.outcome,
          reason: run.reason,
          actions: run.actions,
          ranAt: run.ranAt.toISOString(),
        })),
      };
    });
  }

  async updatePromptLimits(
    principal: StaffPrincipal,
    brandPublicId: string,
    limits: PromptLimits,
  ): Promise<AutomationList> {
    await this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, 'automations.manage', true);
      const before = (await brandSurface(tx, brand.id)).promptLimits;
      await saveSurface(tx, brand, { promptLimits: limits }, this.clock());
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.prompt_limits.updated',
        targetType: 'brand',
        targetId: brandPublicId,
        outcome: 'success',
        data: { before, after: limits },
      });
    });
    return this.list(principal, brandPublicId);
  }
}
