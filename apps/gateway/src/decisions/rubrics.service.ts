import { createHash } from 'node:crypto';
import type {
  DecisionMode,
  DecisionRecord,
  DecisionTask,
  ExperimentReport,
  ReviewDecisionRequest,
  SaveRubricDraftRequest,
} from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  type ExperimentRecord,
  LANGUAGE_SLICES,
  type LanguageSlice,
  summarizeExperiment,
  validateIntents,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, desc, eq, gte, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { authorizedBrand, authorizedBrandById, type BrandRow, idOf } from './access.js';
import {
  intentsOf,
  type RecordRow,
  ROUTING_TASK,
  type RubricRow,
  recordView,
  rubricView,
} from './views.js';

const TASKS = new Set([ROUTING_TASK]);

function taskOf(task: string): string {
  if (!TASKS.has(task)) throw new AppError('NOT_FOUND', { detail: 'Decision task not found.' });
  return task;
}

/** Records page cursor: created_at and id of the last item, opaque to clients. */
function encodeCursor(row: RecordRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}
function decodeCursor(cursor: string): { at: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const date = new Date(at ?? '');
  if (!id || Number.isNaN(date.getTime())) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'cursor', message: 'Invalid cursor' }],
    });
  }
  return { at: date, id };
}

/**
 * Decision rubrics, modes, records, reviews and experiments (J05, J07, J08). Drafts are never
 * used; publishing freezes a version (a database trigger keeps it unchanged). Live routing needs a
 * published rubric. Every change is audited.
 */
@Injectable()
export class RubricsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private get access() {
    return { now: this.clock(), config: this.config };
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    target: { type: string; id: string },
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: target.type,
      targetId: target.id,
      outcome: 'success',
      data,
    });
  }

  private async rubrics(tx: TenantTx, brandId: string, task: string) {
    const rows = await tx
      .select()
      .from(schema.decisionRubrics)
      .where(
        and(
          eq(schema.decisionRubrics.brandId, brandId),
          eq(schema.decisionRubrics.task, task),
          ne(schema.decisionRubrics.state, 'retired'),
        ),
      );
    return {
      published: rows.find((r) => r.state === 'published') ?? null,
      draft: rows.find((r) => r.state === 'draft') ?? null,
    };
  }

  private async taskView(tx: TenantTx, brand: BrandRow, task: string): Promise<DecisionTask> {
    const [settings] = await tx
      .select()
      .from(schema.decisionTasks)
      .where(and(eq(schema.decisionTasks.brandId, brand.id), eq(schema.decisionTasks.task, task)));
    const { published, draft } = await this.rubrics(tx, brand.id, task);
    return {
      brandId: toPublicId('brand', brand.id),
      task: 'team-routing',
      mode: settings?.mode ?? 'shadow',
      published: published ? rubricView(published) : null,
      draft: draft ? rubricView(draft) : null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
    };
  }

  async get(principal: StaffPrincipal, brandPublicId: string, task: string): Promise<DecisionTask> {
    taskOf(task);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      return this.taskView(tx, brand, task);
    });
  }

  async saveDraft(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
    input: z.output<typeof SaveRubricDraftRequest>,
  ) {
    taskOf(task);
    const problem = validateIntents(input.definition.intents);
    if (problem) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'definition.intents', message: problem }],
      });
    }
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.manage',
        this.access,
      );
      const { draft } = await this.rubrics(tx, brand.id, task);
      const values = {
        definition: input.definition,
        provider: input.provider,
        modelVersion: input.provider === 'none' ? null : (input.modelVersion ?? null),
        deadlineMs: input.deadlineMs,
        updatedAt: this.clock(),
      };
      let row: RubricRow | undefined;
      if (draft) {
        [row] = await tx
          .update(schema.decisionRubrics)
          .set(values)
          .where(eq(schema.decisionRubrics.id, draft.id))
          .returning();
      } else {
        const [latest] = await tx
          .select({ version: sql<number>`max(${schema.decisionRubrics.version})` })
          .from(schema.decisionRubrics)
          .where(
            and(
              eq(schema.decisionRubrics.brandId, brand.id),
              eq(schema.decisionRubrics.task, task),
            ),
          );
        [row] = await tx
          .insert(schema.decisionRubrics)
          .values({
            tenantId: principal.tenantId,
            brandId: brand.id,
            task,
            version: Number(latest?.version ?? 0) + 1,
            createdBy: principal.staffMemberId,
            ...values,
          })
          .returning();
      }
      if (!row) throw new Error('rubric draft write returned nothing');
      await this.audit(
        tx,
        principal,
        'decision.rubric.draft_saved',
        {
          type: 'rubric',
          id: toPublicId('rubric', row.id),
        },
        {
          brand: brandPublicId,
          task,
          version: row.version,
          provider: row.provider,
          modelVersion: row.modelVersion,
          intents: input.definition.intents.map((i) => i.key),
        },
      );
      return rubricView(row);
    });
  }

  async publish(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
  ): Promise<DecisionTask> {
    taskOf(task);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.manage',
        this.access,
      );
      const { published, draft } = await this.rubrics(tx, brand.id, task);
      if (!draft) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'draft', message: 'There is no draft to publish.' }],
        });
      }
      if (published) {
        await tx
          .update(schema.decisionRubrics)
          .set({ state: 'retired', updatedAt: this.clock() })
          .where(eq(schema.decisionRubrics.id, published.id));
      }
      const hash = createHash('sha256')
        .update(
          canonicalize({
            definition: draft.definition,
            provider: draft.provider,
            modelVersion: draft.modelVersion,
            deadlineMs: draft.deadlineMs,
          }) ?? '',
        )
        .digest();
      const [row] = await tx
        .update(schema.decisionRubrics)
        .set({
          state: 'published',
          configHash: hash,
          publishedAt: this.clock(),
          publishedBy: principal.staffMemberId,
          updatedAt: this.clock(),
        })
        .where(eq(schema.decisionRubrics.id, draft.id))
        .returning();
      if (!row) throw new Error('rubric publish returned nothing');
      await this.audit(
        tx,
        principal,
        'decision.rubric.published',
        {
          type: 'rubric',
          id: toPublicId('rubric', row.id),
        },
        {
          brand: brandPublicId,
          task,
          version: row.version,
          previousVersion: published?.version ?? null,
          configHash: hash.toString('hex'),
        },
      );
      return this.taskView(tx, brand, task);
    });
  }

  async setMode(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
    mode: DecisionMode,
  ): Promise<DecisionTask> {
    taskOf(task);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.manage',
        this.access,
      );
      const { published } = await this.rubrics(tx, brand.id, task);
      if (mode === 'live' && !published) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'mode', message: 'Publish a rubric before routing goes live.' }],
        });
      }
      const [before] = await tx
        .select()
        .from(schema.decisionTasks)
        .where(
          and(eq(schema.decisionTasks.brandId, brand.id), eq(schema.decisionTasks.task, task)),
        );
      await tx
        .insert(schema.decisionTasks)
        .values({
          tenantId: principal.tenantId,
          brandId: brand.id,
          task,
          mode,
          updatedBy: principal.staffMemberId,
        })
        .onConflictDoUpdate({
          target: [
            schema.decisionTasks.tenantId,
            schema.decisionTasks.brandId,
            schema.decisionTasks.task,
          ],
          set: { mode, updatedBy: principal.staffMemberId, updatedAt: this.clock() },
        });
      await this.audit(
        tx,
        principal,
        'decision.mode_changed',
        {
          type: 'brand',
          id: brandPublicId,
        },
        {
          task,
          from: before?.mode ?? 'shadow',
          to: mode,
          rubricVersion: published?.version ?? null,
        },
      );
      return this.taskView(tx, brand, task);
    });
  }

  private async teamNames(tx: TenantTx, rows: RecordRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((r) => r.teamId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const teams = await tx
      .select({ id: schema.routingTeams.id, name: schema.routingTeams.name })
      .from(schema.routingTeams)
      .where(inArray(schema.routingTeams.id, ids));
    return new Map(teams.map((t) => [t.id, t.name]));
  }

  async records(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
    query: { status?: string; conversationId?: string; limit: number; cursor?: string },
  ): Promise<{ items: DecisionRecord[]; nextCursor: string | null }> {
    taskOf(task);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      const r = schema.decisionRecords;
      const after = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await tx
        .select()
        .from(r)
        .where(
          and(
            eq(r.brandId, brand.id),
            eq(r.task, task),
            query.status ? eq(r.status, query.status as RecordRow['status']) : undefined,
            query.conversationId
              ? eq(r.conversationId, idOf('conversation', query.conversationId, 'Conversation'))
              : undefined,
            after
              ? or(lt(r.createdAt, after.at), and(eq(r.createdAt, after.at), lt(r.id, after.id)))
              : undefined,
          ),
        )
        .orderBy(desc(r.createdAt), desc(r.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const names = await this.teamNames(tx, page);
      const last = page.at(-1);
      return {
        items: page.map((row) =>
          recordView(row, row.teamId ? (names.get(row.teamId) ?? null) : null),
        ),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      };
    });
  }

  private async recordFor(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: 'decisions.read' | 'decisions.manage',
  ) {
    const id = idOf('decision', publicId, 'Decision');
    const [row] = await tx
      .select()
      .from(schema.decisionRecords)
      .where(eq(schema.decisionRecords.id, id));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Decision not found.' });
    await authorizedBrandById(tx, principal, row.brandId, permission, this.access);
    return row;
  }

  async record(principal: StaffPrincipal, publicId: string): Promise<DecisionRecord> {
    return this.tx(principal, async (tx) => {
      const row = await this.recordFor(tx, principal, publicId, 'decisions.read');
      const names = await this.teamNames(tx, [row]);
      return recordView(row, row.teamId ? (names.get(row.teamId) ?? null) : null);
    });
  }

  /** A reviewer's correction (HNV-12-06): kept next to the original advice, never replacing it. */
  async review(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ReviewDecisionRequest>,
  ): Promise<DecisionRecord> {
    return this.tx(principal, async (tx) => {
      const row = await this.recordFor(tx, principal, publicId, 'decisions.manage');
      if (!row.offered.includes(input.intent)) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'intent', message: 'Choose one of the intents this decision offered.' }],
        });
      }
      const [updated] = await tx
        .update(schema.decisionRecords)
        .set({
          reviewedIntent: input.intent,
          reviewReason: input.reason,
          reviewedBy: principal.staffMemberId,
          reviewedAt: this.clock(),
          trainingConsent: input.trainingConsent,
        })
        .where(eq(schema.decisionRecords.id, row.id))
        .returning();
      if (!updated) throw new Error('decision review returned nothing');
      await this.audit(
        tx,
        principal,
        'decision.reviewed',
        { type: 'decision', id: publicId },
        {
          original: row.finalIntent,
          reviewed: input.intent,
          agrees: row.finalIntent === input.intent,
          trainingConsent: input.trainingConsent,
        },
      );
      const names = await this.teamNames(tx, [updated]);
      return recordView(updated, updated.teamId ? (names.get(updated.teamId) ?? null) : null);
    });
  }

  /** Provider versus baseline over shadow and live decisions of the last `days` days (J08). */
  async experiment(
    principal: StaffPrincipal,
    brandPublicId: string,
    task: string,
    days: number,
  ): Promise<ExperimentReport> {
    taskOf(task);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      const since = new Date(this.clock().getTime() - days * 86_400_000);
      const r = schema.decisionRecords;
      const rows = await tx
        .select()
        .from(r)
        .where(
          and(
            eq(r.brandId, brand.id),
            eq(r.task, task),
            inArray(r.mode, ['shadow', 'live']),
            ne(r.status, 'skipped'),
            gte(r.createdAt, since),
          ),
        );
      const records: ExperimentRecord[] = rows.map((row) => ({
        status: row.status,
        language: (LANGUAGE_SLICES as readonly string[]).includes(row.language ?? '')
          ? (row.language as LanguageSlice)
          : null,
        providerIntent: row.status === 'decided' ? row.providerIntent : null,
        baselineIntent: row.baselineIntent,
        reviewedIntent: row.reviewedIntent,
        latencyMs: row.latencyMs,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      }));
      const summary = summarizeExperiment(records);
      return {
        brandId: toPublicId('brand', brand.id),
        task: 'team-routing',
        since: since.toISOString(),
        overall: summary.overall,
        byLanguage: Object.fromEntries(
          Object.entries(summary.byLanguage).filter(([, value]) => value !== undefined),
        ) as ExperimentReport['byLanguage'],
      };
    });
  }

  /** Intents of a brand's rubric, for routing and tests. */
  static intents(row: RubricRow) {
    return intentsOf(row);
  }
}
