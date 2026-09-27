import type { Run } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, type SQL, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type RunRow = typeof schema.runs.$inferSelect;
type StepRow = typeof schema.runSteps.$inferSelect;
export type RunOutcome = NonNullable<RunRow['outcome']>;

export interface StepInput {
  kind: StepRow['kind'];
  name: string;
  status: StepRow['status'];
  provider?: string | null;
  modelId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  inputHash?: Buffer | null;
  outputHash?: Buffer | null;
  detail?: Record<string, unknown>;
}

function stepView(row: StepRow): NonNullable<Run['steps']>[number] {
  return {
    seq: row.seq,
    kind: row.kind,
    name: row.name,
    status: row.status,
    provider: row.provider,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    detail: row.detail as Record<string, unknown>,
  };
}

function runView(row: RunRow, version: number | null, steps?: StepRow[]): Run {
  return {
    id: toPublicId('run', row.id),
    conversationId: toPublicId('conversation', row.conversationId),
    agentId: row.agentId ? toPublicId('agent', row.agentId) : null,
    agentVersion: version,
    kind: row.kind,
    state: row.state,
    outcome: row.outcome,
    provider: row.provider,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    latencyMs: row.latencyMs,
    errorKind: row.errorKind,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
    ...(steps ? { steps: steps.map(stepView) } : {}),
  };
}

/**
 * Run telemetry (G12, X11): which agent version and model ran, tokens, latency and outcome.
 * Prompts and replies are represented only by hashes.
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Starts a run, or returns the existing one for the same trigger (outbox retries). */
  async start(
    tx: TenantTx,
    input: {
      tenantId: string;
      conversationId: string;
      brandId: string | null;
      agentId: string | null;
      agentVersionId: string | null;
      triggerRef: string;
      kind: RunRow['kind'];
      epoch: number;
    },
  ): Promise<RunRow> {
    const [row] = await tx
      .insert(schema.runs)
      .values(input)
      .onConflictDoUpdate({
        target: [schema.runs.tenantId, schema.runs.conversationId, schema.runs.triggerRef],
        set: { attempts: sql`${schema.runs.attempts} + 1` },
      })
      .returning();
    if (!row) throw new Error('run insert returned nothing');
    return row;
  }

  async step(tx: TenantTx, tenantId: string, runId: string, input: StepInput): Promise<void> {
    const [last] = await tx
      .select({ seq: sql<number>`coalesce(max(${schema.runSteps.seq}), -1)` })
      .from(schema.runSteps)
      .where(eq(schema.runSteps.runId, runId));
    await tx.insert(schema.runSteps).values({
      tenantId,
      runId,
      seq: (last?.seq ?? -1) + 1,
      kind: input.kind,
      name: input.name,
      status: input.status,
      provider: input.provider ?? null,
      modelId: input.modelId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      latencyMs: input.latencyMs ?? null,
      inputHash: input.inputHash ?? null,
      outputHash: input.outputHash ?? null,
      detail: input.detail ?? {},
    });
  }

  async finish(
    tx: TenantTx,
    runId: string,
    input: {
      outcome: RunOutcome;
      state?: RunRow['state'];
      provider?: string | null;
      modelId?: string | null;
      inputTokens?: number | null;
      outputTokens?: number | null;
      latencyMs?: number | null;
      errorKind?: string | null;
    },
  ): Promise<void> {
    const failed = input.outcome === 'error';
    await tx
      .update(schema.runs)
      .set({
        state: input.state ?? (failed ? 'failed' : 'succeeded'),
        outcome: input.outcome,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
        ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
        ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
        ...(input.errorKind !== undefined ? { errorKind: input.errorKind } : {}),
        finishedAt: this.clock(),
      })
      .where(eq(schema.runs.id, runId));
  }

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private readable(principal: StaffPrincipal, row: { brandId: string | null }) {
    return authorize(principal, 'analytics.read', row.brandId ? { brandId: row.brandId } : {}, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private async versionNumbers(tx: TenantTx, rows: RunRow[]) {
    const ids = [...new Set(rows.map((r) => r.agentVersionId).filter((v) => v !== null))];
    if (ids.length === 0) return new Map<string, number>();
    const versions = await tx
      .select({ id: schema.agentVersions.id, version: schema.agentVersions.version })
      .from(schema.agentVersions)
      .where(inArray(schema.agentVersions.id, ids));
    return new Map(versions.map((v) => [v.id, v.version]));
  }

  async list(
    principal: StaffPrincipal,
    query: { conversationId?: string; agentId?: string; limit: number; cursor?: string },
  ): Promise<{ items: Run[]; nextCursor: string | null }> {
    const filters: SQL[] = [];
    if (query.conversationId) {
      filters.push(
        eq(schema.runs.conversationId, fromPublicId('conversation', query.conversationId)),
      );
    }
    if (query.agentId) filters.push(eq(schema.runs.agentId, fromPublicId('agent', query.agentId)));
    // Run IDs are UUIDv7, so ID order is start order and the last ID is an exact cursor.
    if (query.cursor) filters.push(lt(schema.runs.id, fromPublicId('run', query.cursor)));
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.runs)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(schema.runs.id))
        .limit(query.limit + 1);
      const visible = rows.filter((row) => this.readable(principal, row).allowed);
      const page = visible.slice(0, query.limit);
      const versions = await this.versionNumbers(tx, page);
      const last = page.at(-1);
      return {
        items: page.map((row) =>
          runView(row, row.agentVersionId ? (versions.get(row.agentVersionId) ?? null) : null),
        ),
        nextCursor: rows.length > query.limit && last ? toPublicId('run', last.id) : null,
      };
    });
  }

  async get(principal: StaffPrincipal, publicId: string): Promise<Run> {
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.id, fromPublicId('run', publicId)));
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Run not found.' });
      enforce(this.readable(principal, row));
      const steps = await tx
        .select()
        .from(schema.runSteps)
        .where(eq(schema.runSteps.runId, row.id))
        .orderBy(asc(schema.runSteps.seq));
      const versions = await this.versionNumbers(tx, [row]);
      return runView(
        row,
        row.agentVersionId ? (versions.get(row.agentVersionId) ?? null) : null,
        steps,
      );
    });
  }
}
