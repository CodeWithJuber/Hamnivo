import { createHash } from 'node:crypto';
import type {
  CheckRecord,
  CheckRubric,
  CheckTask as CheckTaskView,
  CheckThresholds,
  DecisionMode,
  SaveCheckDraftRequest,
} from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  CHECK_TASK_SPECS,
  CHECK_TASKS,
  type CheckTask,
  DEFAULT_CHECK_THRESHOLDS,
  DEFAULT_DECISION_THRESHOLDS,
  isCheckTask,
} from '@hamnivo/domain';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { authorizedBrand, type BrandRow, idOf } from '../decisions/access.js';
import { DecisionProviders } from '../decisions/providers.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { CheckRow, RubricRow } from './checks.service.js';
import { checkQuestions, checkRecordView, checkRubricView } from './views.js';

function taskOf(task: string): CheckTask {
  if (!isCheckTask(task)) throw new AppError('NOT_FOUND', { detail: 'Check not found.' });
  return task;
}

/** Thresholds for questions the check asks, of the right kind; anything else is refused. */
function thresholdProblems(task: CheckTask, thresholds: CheckThresholds) {
  const spec = CHECK_TASK_SPECS[task];
  const problems: { path: string; message: string }[] = [];
  for (const [slice, byKey] of Object.entries(thresholds)) {
    for (const [key, threshold] of Object.entries(byKey ?? {})) {
      const kind = Object.hasOwn(spec.thresholds, key) ? spec.thresholds[key] : undefined;
      if (!kind) {
        problems.push({
          path: `thresholds.${slice}.${key}`,
          message: 'This check asks no such question',
        });
      } else if (kind !== threshold.type) {
        problems.push({
          path: `thresholds.${slice}.${key}`,
          message: `This question is a ${kind}, not a ${threshold.type}`,
        });
      }
    }
  }
  return problems;
}

function encodeCursor(row: CheckRow): string {
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
 * Checks around AI replies in Studio: versioned rubrics with thresholds per language, shadow and
 * live modes per brand (every brand starts in shadow), and their records. Reading needs
 * `decisions.read`; changes need `decisions.manage` and are audited.
 */
@Injectable()
export class ChecksAdminService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly providers: DecisionProviders,
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

  private async rubrics(tx: TenantTx, brandId: string, task: CheckTask) {
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

  /** Thresholds measured live for the recommended version (docs/evals), by task. */
  private recommended(task: CheckTask): CheckThresholds {
    const defaults = DEFAULT_CHECK_THRESHOLDS[task];
    return defaults &&
      DEFAULT_DECISION_THRESHOLDS.model === this.providers.jevStatus().recommendedModel
      ? (defaults as CheckThresholds)
      : {};
  }

  private async view(tx: TenantTx, brand: BrandRow, task: CheckTask): Promise<CheckTaskView> {
    const [settings] = await tx
      .select()
      .from(schema.decisionTasks)
      .where(and(eq(schema.decisionTasks.brandId, brand.id), eq(schema.decisionTasks.task, task)));
    const { published, draft } = await this.rubrics(tx, brand.id, task);
    return {
      brandId: toPublicId('brand', brand.id),
      task,
      mode: settings?.mode ?? 'shadow',
      published: published ? checkRubricView(published) : null,
      draft: draft ? checkRubricView(draft) : null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
      questions: checkQuestions(task),
      recommendedThresholds: this.recommended(task),
      jev: this.providers.jevStatus(),
    };
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<CheckTaskView[]> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      const views: CheckTaskView[] = [];
      for (const task of CHECK_TASKS) views.push(await this.view(tx, brand, task));
      return views;
    });
  }

  async saveDraft(
    principal: StaffPrincipal,
    brandPublicId: string,
    taskName: string,
    input: z.output<typeof SaveCheckDraftRequest>,
  ): Promise<CheckRubric> {
    const task = taskOf(taskName);
    const problems = thresholdProblems(task, input.thresholds);
    if (problems.length > 0) throw new AppError('VALIDATION_FAILED', { fields: problems });
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
        definition: { thresholds: input.thresholds },
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
      if (!row) throw new Error('check draft write returned nothing');
      await this.audit(
        tx,
        principal,
        'decision.rubric.draft_saved',
        { type: 'rubric', id: toPublicId('rubric', row.id) },
        {
          brand: brandPublicId,
          task,
          version: row.version,
          provider: row.provider,
          modelVersion: row.modelVersion,
          languages: Object.keys(input.thresholds),
        },
      );
      return checkRubricView(row);
    });
  }

  async publish(
    principal: StaffPrincipal,
    brandPublicId: string,
    taskName: string,
  ): Promise<CheckTaskView> {
    const task = taskOf(taskName);
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
            task,
            questionsVersion: CHECK_TASK_SPECS[task].questionsVersion,
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
      if (!row) throw new Error('check publish returned nothing');
      await this.audit(
        tx,
        principal,
        'decision.rubric.published',
        { type: 'rubric', id: toPublicId('rubric', row.id) },
        {
          brand: brandPublicId,
          task,
          version: row.version,
          previousVersion: published?.version ?? null,
          configHash: hash.toString('hex'),
        },
      );
      return this.view(tx, brand, task);
    });
  }

  async setMode(
    principal: StaffPrincipal,
    brandPublicId: string,
    taskName: string,
    mode: DecisionMode,
  ): Promise<CheckTaskView> {
    const task = taskOf(taskName);
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
          fields: [{ path: 'mode', message: 'Publish a rubric before the check goes live.' }],
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
        { type: 'brand', id: brandPublicId },
        {
          task,
          from: before?.mode ?? 'shadow',
          to: mode,
          rubricVersion: published?.version ?? null,
        },
      );
      return this.view(tx, brand, task);
    });
  }

  async records(
    principal: StaffPrincipal,
    brandPublicId: string,
    taskName: string,
    query: { conversationId?: string; limit: number; cursor?: string },
  ): Promise<{ items: CheckRecord[]; nextCursor: string | null }> {
    const task = taskOf(taskName);
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      const c = schema.decisionChecks;
      const after = query.cursor ? decodeCursor(query.cursor) : null;
      const rows = await tx
        .select()
        .from(c)
        .where(
          and(
            eq(c.brandId, brand.id),
            eq(c.task, task),
            query.conversationId
              ? eq(c.conversationId, idOf('conversation', query.conversationId, 'Conversation'))
              : undefined,
            after
              ? or(lt(c.createdAt, after.at), and(eq(c.createdAt, after.at), lt(c.id, after.id)))
              : undefined,
          ),
        )
        .orderBy(desc(c.createdAt), desc(c.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(checkRecordView),
        nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      };
    });
  }
}
