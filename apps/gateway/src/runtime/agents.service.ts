import { createHash } from 'node:crypto';
import {
  type Agent,
  AgentConfig,
  type AgentDetail,
  type AgentVersion,
  type CreateAgentRequest,
  type PublishAgentRequest,
  type SaveAgentDraftRequest,
  type UpdateAgentRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { AiHandoffReason } from './handoff-notes.js';
import { KillSwitchesService } from './kill-switches.service.js';
import { ModelFactory, ModelUnavailableError } from './models.js';

type ProfileRow = typeof schema.agentProfiles.$inferSelect;
type VersionRow = typeof schema.agentVersions.$inferSelect;

/** The agent that answers a brand's conversations, as the runtime sees it. */
export interface ActiveAgent {
  profile: ProfileRow;
  version: VersionRow;
  config: AgentConfig;
}

export const configHash = (config: AgentConfig) =>
  createHash('sha256')
    .update(canonicalize(config) ?? '')
    .digest();

function versionView(row: VersionRow): AgentVersion {
  return {
    id: toPublicId('agentVersion', row.id),
    agentId: toPublicId('agent', row.profileId),
    version: row.version,
    state: row.state,
    config: AgentConfig.parse(row.config),
    configHash: row.configHash ? row.configHash.toString('hex') : null,
    createdAt: row.createdAt.toISOString(),
    publishedAt: iso(row.publishedAt),
    publishedBy: row.publishedBy ? toPublicId('staff', row.publishedBy) : null,
  };
}

function agentView(row: ProfileRow, versions: VersionRow[]): Agent {
  const published = versions.find((v) => v.id === row.publishedVersionId);
  const draft = versions.find((v) => v.state === 'draft');
  return {
    id: toPublicId('agent', row.id),
    workspaceId: toPublicId('workspace', row.workspaceId),
    brandId: toPublicId('brand', row.brandId),
    name: row.name,
    status: row.status,
    isDefault: row.isDefault,
    publishedVersion: published?.version ?? null,
    draftVersion: draft?.version ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * AI agents (G01) with draft/publish configuration (A07): drafts change freely, a published
 * version never changes, and publishing an earlier version is the rollback.
 */
@Injectable()
export class AgentsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly models: ModelFactory,
    private readonly switches: KillSwitchesService,
  ) {}

  private allowed(principal: StaffPrincipal, permission: Permission, row: ProfileRow) {
    return authorize(
      principal,
      permission,
      { workspaceId: row.workspaceId, brandId: row.brandId },
      { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
    );
  }

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    profileId: string,
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'agent',
      targetId: toPublicId('agent', profileId),
      outcome: 'success',
      data,
    });
  }

  private async load(tx: TenantTx, publicId: string, lock = false): Promise<ProfileRow> {
    const query = tx
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, fromPublicId('agent', publicId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Agent not found.' });
    return row;
  }

  private versionsOf(tx: TenantTx, profileId: string) {
    return tx
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.profileId, profileId))
      .orderBy(desc(schema.agentVersions.version));
  }

  private detail(row: ProfileRow, versions: VersionRow[]): AgentDetail {
    const published = versions.find((v) => v.id === row.publishedVersionId);
    const draft = versions.find((v) => v.state === 'draft');
    return {
      agent: agentView(row, versions),
      published: published ? versionView(published) : null,
      draft: draft ? versionView(draft) : null,
    };
  }

  /** Makes this agent the brand's only default. */
  private async clearOtherDefaults(tx: TenantTx, row: { id: string; brandId: string }) {
    await tx
      .update(schema.agentProfiles)
      .set({ isDefault: false, updatedAt: this.clock() })
      .where(
        and(
          eq(schema.agentProfiles.brandId, row.brandId),
          ne(schema.agentProfiles.id, row.id),
          eq(schema.agentProfiles.isDefault, true),
        ),
      );
  }

  async list(principal: StaffPrincipal): Promise<Agent[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.agentProfiles)
        .orderBy(asc(schema.agentProfiles.createdAt));
      const visible = rows.filter((row) => this.allowed(principal, 'agents.read', row).allowed);
      const versions = visible.length
        ? await tx
            .select()
            .from(schema.agentVersions)
            .where(sql`${schema.agentVersions.state} in ('draft', 'published')`)
        : [];
      return visible.map((row) =>
        agentView(
          row,
          versions.filter((v) => v.profileId === row.id),
        ),
      );
    });
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateAgentRequest>,
  ): Promise<AgentDetail> {
    const brandId = fromPublicId('brand', input.brandId);
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        authorize(
          principal,
          'agents.manage',
          { workspaceId: brand.workspaceId, brandId },
          { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
        ),
      );
      const [row] = await tx
        .insert(schema.agentProfiles)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          name: input.name,
        })
        .returning();
      if (!row) throw new Error('agent insert returned nothing');
      let profile = row;
      if (input.isDefault) {
        await this.clearOtherDefaults(tx, row);
        [profile = row] = await tx
          .update(schema.agentProfiles)
          .set({ isDefault: true })
          .where(eq(schema.agentProfiles.id, row.id))
          .returning();
      }
      const [draft] = await tx
        .insert(schema.agentVersions)
        .values({
          tenantId: principal.tenantId,
          profileId: row.id,
          version: 1,
          config: input.config,
          createdBy: principal.staffMemberId,
        })
        .returning();
      await this.audit(tx, principal, 'agent.created', row.id, {
        name: row.name,
        brand: input.brandId,
        isDefault: input.isDefault,
      });
      return this.detail(profile, draft ? [draft] : []);
    });
  }

  async get(principal: StaffPrincipal, publicId: string): Promise<AgentDetail> {
    return this.tx(principal, async (tx) => {
      const row = await this.load(tx, publicId);
      enforce(this.allowed(principal, 'agents.read', row));
      return this.detail(row, await this.versionsOf(tx, row.id));
    });
  }

  async versions(principal: StaffPrincipal, publicId: string): Promise<AgentVersion[]> {
    return this.tx(principal, async (tx) => {
      const row = await this.load(tx, publicId);
      enforce(this.allowed(principal, 'agents.read', row));
      return (await this.versionsOf(tx, row.id)).map(versionView);
    });
  }

  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateAgentRequest>,
  ): Promise<Agent> {
    return this.tx(principal, async (tx) => {
      const row = await this.load(tx, publicId, true);
      enforce(this.allowed(principal, 'agents.manage', row));
      if (input.isDefault) await this.clearOtherDefaults(tx, row);
      const [updated] = await tx
        .update(schema.agentProfiles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          updatedAt: this.clock(),
        })
        .where(eq(schema.agentProfiles.id, row.id))
        .returning();
      if (!updated) throw new Error('agent update returned nothing');
      await this.audit(tx, principal, 'agent.updated', row.id, { ...input });
      return agentView(updated, await this.versionsOf(tx, row.id));
    });
  }

  async saveDraft(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof SaveAgentDraftRequest>,
  ): Promise<AgentVersion> {
    return this.tx(principal, async (tx) => {
      const row = await this.load(tx, publicId, true);
      enforce(this.allowed(principal, 'agents.manage', row));
      const versions = await this.versionsOf(tx, row.id);
      const draft = versions.find((v) => v.state === 'draft');
      if (input.baseVersion !== undefined && input.baseVersion !== draft?.version) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Someone saved a newer draft. Reload it and apply your changes again.',
        });
      }
      let saved: VersionRow | undefined;
      if (draft) {
        [saved] = await tx
          .update(schema.agentVersions)
          .set({
            config: input.config,
            createdBy: principal.staffMemberId,
            updatedAt: this.clock(),
          })
          .where(eq(schema.agentVersions.id, draft.id))
          .returning();
      } else {
        [saved] = await tx
          .insert(schema.agentVersions)
          .values({
            tenantId: principal.tenantId,
            profileId: row.id,
            version: (versions[0]?.version ?? 0) + 1,
            config: input.config,
            createdBy: principal.staffMemberId,
          })
          .returning();
      }
      if (!saved) throw new Error('draft save returned nothing');
      await this.audit(tx, principal, 'agent.draft_saved', row.id, { version: saved.version });
      return versionView(saved);
    });
  }

  async publish(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof PublishAgentRequest>,
  ): Promise<AgentDetail> {
    return this.tx(principal, async (tx) => {
      const row = await this.load(tx, publicId, true);
      enforce(this.allowed(principal, 'agents.publish', row));
      if (row.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', { detail: 'Archived agents cannot be published.' });
      }
      const versions = await this.versionsOf(tx, row.id);
      const target =
        input.version !== undefined
          ? versions.find((v) => v.version === input.version)
          : versions.find((v) => v.state === 'draft');
      if (!target) {
        throw new AppError('NOT_FOUND', {
          detail: input.version ? `Version ${input.version} not found.` : 'There is no draft.',
        });
      }
      if (target.id === row.publishedVersionId) return this.detail(row, versions);
      const config = AgentConfig.parse(target.config);
      try {
        for (const choice of [config.model, ...config.fallbackModels]) {
          await this.models.check(tx, choice);
        }
      } catch (error) {
        if (error instanceof ModelUnavailableError) {
          throw new AppError('VALIDATION_FAILED', {
            detail: error.message,
            fields: [{ path: 'config.model', message: error.message }],
          });
        }
        throw error;
      }
      if (config.knowledgeSourceIds.length > 0) {
        const ids = config.knowledgeSourceIds.map((id) => fromPublicId('source', id));
        const sources = await tx
          .select()
          .from(schema.knowledgeSources)
          .where(inArray(schema.knowledgeSources.id, ids));
        const usable = new Set(
          sources
            .filter((s) => s.brandId === row.brandId && s.status !== 'retired')
            .map((s) => s.id),
        );
        if (ids.some((id) => !usable.has(id))) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Some knowledge sources are missing, retired or belong to another brand.',
            fields: [{ path: 'config.knowledgeSourceIds', message: 'Unknown or unusable source' }],
          });
        }
      }
      const now = this.clock();
      // The live version retires first: at most one version is published at a time.
      await tx
        .update(schema.agentVersions)
        .set({ state: 'retired', updatedAt: now })
        .where(
          and(
            eq(schema.agentVersions.profileId, row.id),
            eq(schema.agentVersions.state, 'published'),
          ),
        );
      await tx
        .update(schema.agentVersions)
        .set(
          target.state === 'draft'
            ? {
                state: 'published',
                configHash: configHash(config),
                publishedAt: now,
                publishedBy: principal.staffMemberId,
                updatedAt: now,
              }
            : { state: 'published', updatedAt: now },
        )
        .where(eq(schema.agentVersions.id, target.id));
      await tx
        .update(schema.agentProfiles)
        .set({ publishedVersionId: target.id, updatedAt: now })
        .where(eq(schema.agentProfiles.id, row.id));
      await this.audit(tx, principal, 'agent.published', row.id, {
        version: target.version,
        rollback: target.state !== 'draft',
        configHash: (target.configHash ?? configHash(config)).toString('hex'),
        model: `${config.model.provider}/${config.model.modelId}`,
        mode: config.mode,
      });
      const [updated] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, row.id));
      return this.detail(updated ?? row, await this.versionsOf(tx, row.id));
    });
  }

  /**
   * Creates the brand's default agent as an unpublished draft, once. Nothing AI-written reaches
   * customers until someone publishes it.
   */
  async ensureDefaultDraft(tx: TenantTx, brand: typeof schema.brands.$inferSelect): Promise<void> {
    const [existing] = await tx
      .select({ id: schema.agentProfiles.id })
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.brandId, brand.id))
      .limit(1);
    if (existing) return;
    const config: AgentConfig = AgentConfig.parse({
      displayName: 'AI assistant',
      purpose: `Answer questions from ${brand.name}'s customers and hand over to a person when needed.`,
      model: { provider: 'mock', modelId: 'hamnivo-mock' },
    });
    try {
      // A savepoint, so losing a race to another default keeps the outer transaction usable.
      await tx.transaction(async (sp) => {
        const [profile] = await sp
          .insert(schema.agentProfiles)
          .values({
            tenantId: brand.tenantId,
            workspaceId: brand.workspaceId,
            brandId: brand.id,
            name: `${brand.name} assistant`,
            isDefault: true,
          })
          .returning();
        if (!profile) return;
        await sp
          .insert(schema.agentVersions)
          .values({ tenantId: brand.tenantId, profileId: profile.id, version: 1, config });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** Whether the AI answers the brand's new conversations, and why not when it does not. */
  async answering(
    tx: TenantTx,
    brandId: string,
  ): Promise<
    { answering: true; agent: ActiveAgent } | { answering: false; reason: AiHandoffReason }
  > {
    const agent = await this.activeFor(tx, brandId);
    if (!agent) return { answering: false, reason: 'no_agent' };
    if (agent.config.mode !== 'answer') return { answering: false, reason: 'assist_mode' };
    if (await this.switches.activeFor(tx, { brandId, agentId: agent.profile.id })) {
      return { answering: false, reason: 'ai_stopped' };
    }
    return { answering: true, agent };
  }

  /** The brand's default agent with its published version, or null when none can answer. */
  async activeFor(tx: TenantTx, brandId: string): Promise<ActiveAgent | null> {
    const [found] = await tx
      .select({ profile: schema.agentProfiles, version: schema.agentVersions })
      .from(schema.agentProfiles)
      .innerJoin(
        schema.agentVersions,
        eq(schema.agentVersions.id, schema.agentProfiles.publishedVersionId),
      )
      .where(
        and(
          eq(schema.agentProfiles.brandId, brandId),
          eq(schema.agentProfiles.isDefault, true),
          eq(schema.agentProfiles.status, 'active'),
        ),
      );
    if (!found) return null;
    return { ...found, config: AgentConfig.parse(found.version.config) };
  }
}
