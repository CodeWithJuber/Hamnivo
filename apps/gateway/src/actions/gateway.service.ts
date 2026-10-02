import { createHash } from 'node:crypto';
import type { AgentConfig } from '@hamnivo/contracts';
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
import {
  type ActionEvidence,
  type ActionState,
  actionCode,
  approvalExpiry,
  approvalNeedsStepUp,
  canonicalHash,
  containToolOutput,
  decideExecution,
  type FencedToolResult,
  fenceToolResult,
  type JsonValue,
  type RiskClass,
  sanitizeToolSchema,
  type ToolResultStatus,
  toJsonSchema,
  validateAgainstSchema,
} from '@hamnivo/domain/actions';
import { Inject, Injectable } from '@nestjs/common';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';
import { and, count, eq, gt, inArray, sql } from 'drizzle-orm';
import { OwnershipService } from '../authority/ownership.service.js';
import { CommerceCardsService } from '../commerce/card-publisher.service.js';
import type { AppConfig } from '../config.js';
import { KillSwitchesService } from '../runtime/kill-switches.service.js';
import { RunsService } from '../runtime/runs.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ToolAdapters, ToolCallFailure, type ToolRow, type ToolScope } from './adapters.js';
import { BUILTIN_TOOLS } from './builtins.js';
import { approvalPublication } from './cards.js';
import { ActionExecutor } from './executor.service.js';
import { REASON_TEXT } from './views.js';

/** One customer-facing run that may call tools. */
export interface RunToolsContext {
  tenantId: string;
  brandId: string;
  conversationId: string;
  principalId: string | null;
  runId: string;
  epoch: number;
  agentId: string;
  agentVersionId: string;
  agentDisplayName: string;
  config: AgentConfig;
  /** Aborting it cancels the run's tool calls in flight. */
  controller: AbortController;
}

export interface CalledAction {
  actionId: string;
  tool: string;
  risk: RiskClass;
  state: ActionState | 'invalid' | 'fenced';
}

/** At most `size` tool calls of one run at a time (X03). */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

/** The tools of one run and what they did. */
export class RunTools {
  calls = 0;
  /** Untrusted tool output entered the run (X09): later changes wait for a person. */
  untrusted = false;
  readonly called: CalledAction[] = [];
  /** The same call again in this run (a guard retry) gets the same result, not a second action. */
  readonly results = new Map<string, FencedToolResult>();
  readonly gate: Gate;
  private watch: NodeJS.Timeout | undefined;

  constructor(
    readonly context: RunToolsContext,
    readonly tools: ToolSet,
    parallel: number,
  ) {
    this.gate = new Gate(parallel);
  }

  get signal(): AbortSignal {
    return this.context.controller.signal;
  }

  /** Watches for a stop request or a takeover while the run is alive. */
  startWatch(check: () => Promise<string | null>, everyMs = 200): void {
    const tick = async () => {
      if (this.signal.aborted) return;
      const reason = await check().catch(() => null);
      if (reason) this.context.controller.abort(reason);
    };
    this.watch = setInterval(() => void tick(), everyMs);
  }

  close(): void {
    if (this.watch) clearInterval(this.watch);
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** Actions that still wait for a decision, a send or a result. */
const PENDING_STATES = new Set<ActionState>([
  'awaiting_approval',
  'approved',
  'executing',
  'unknown',
]);

/**
 * The tool authorization gateway (G07, G08, G15, X02, X03, X09). The model sees only the tools the
 * agent version was granted, described by Hamnivo; every call is validated against the tool's
 * schema, reauthorized against current records (ownership epoch, tool status and revision, kill
 * switches, budgets), recorded as an action, and either run on autopilot, sent for approval or
 * refused. What comes back is fenced as untrusted data with a summary Hamnivo wrote; nothing a
 * tool returns can add a tool, change a policy or approve anything.
 */
@Injectable()
export class ToolGateway {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly adapters: ToolAdapters,
    private readonly executor: ActionExecutor,
    private readonly switches: KillSwitchesService,
    private readonly runs: RunsService,
    private readonly ownership: OwnershipService,
    private readonly cards: CommerceCardsService,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai' }, work);
  }

  /** The granted, usable tools of an agent version for one brand. */
  async grantedTools(tx: TenantTx, brandId: string, config: AgentConfig): Promise<ToolRow[]> {
    const ids = config.tools.grants.map((g) => fromPublicId('tool', g.toolId));
    if (ids.length === 0) return [];
    const rows = await tx
      .select()
      .from(schema.toolDefinitions)
      .where(
        and(
          inArray(schema.toolDefinitions.id, ids),
          eq(schema.toolDefinitions.brandId, brandId),
          eq(schema.toolDefinitions.status, 'enabled'),
        ),
      );
    return rows.filter(
      (row) =>
        row.builtin === null || !BUILTIN_TOOLS[row.builtin].demo || this.adapters.demoAllowed(),
    );
  }

  /** The tool set for a run, or null when the agent has no usable tools. */
  async forRun(context: RunToolsContext): Promise<RunTools | null> {
    const rows = await this.tx(context.tenantId, (tx) =>
      this.grantedTools(tx, context.brandId, context.config),
    );
    if (rows.length === 0) return null;
    const tools: ToolSet = {};
    const run = new RunTools(context, tools, this.config.TOOLS_MAX_PARALLEL);
    for (const row of rows) {
      const parsed = sanitizeToolSchema(row.inputSchema, { trusted: row.source === 'builtin' });
      if (!parsed.ok) continue;
      tools[row.name] = dynamicTool({
        description: row.description,
        inputSchema: jsonSchema(toJsonSchema(parsed.schema) as Parameters<typeof jsonSchema>[0]),
        execute: (input) => this.call(run, row.id, input),
      });
    }
    if (Object.keys(tools).length === 0) return null;
    run.startWatch(() => this.stopReason(context));
    return run;
  }

  /** Why the run must stop now: a person asked, or someone else took the conversation. */
  private async stopReason(context: RunToolsContext): Promise<string | null> {
    return this.tx(context.tenantId, async (tx) => {
      const [run] = await tx
        .select({ cancel: schema.runs.cancelRequestedAt })
        .from(schema.runs)
        .where(eq(schema.runs.id, context.runId));
      if (run?.cancel) return 'cancel_requested';
      const [control] = await tx
        .select({
          mode: schema.conversationControls.ownerMode,
          epoch: schema.conversationControls.ownershipEpoch,
        })
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.id, context.conversationId));
      if (control?.mode !== 'AI_ACTIVE' || control.epoch !== context.epoch) {
        return 'owner_changed';
      }
      return null;
    });
  }

  private async step(
    run: RunTools,
    name: string,
    status: 'ok' | 'error' | 'blocked' | 'skipped',
    detail: Record<string, unknown>,
    extra: { latencyMs?: number; inputHash?: Buffer; outputHash?: Buffer } = {},
  ) {
    await this.tx(run.context.tenantId, (tx) =>
      this.runs.step(tx, run.context.tenantId, run.context.runId, {
        kind: 'tool',
        name,
        status,
        ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
        ...(extra.inputHash ? { inputHash: extra.inputHash } : {}),
        ...(extra.outputHash ? { outputHash: extra.outputHash } : {}),
        detail,
      }),
    );
  }

  /** One tool call from the model. Always resolves with a fenced result the model may read. */
  async call(run: RunTools, toolId: string, input: unknown): Promise<FencedToolResult> {
    return run.gate.run(async () => {
      const started = Date.now();
      const [tool] = await this.tx(run.context.tenantId, (tx) =>
        tx.select().from(schema.toolDefinitions).where(eq(schema.toolDefinitions.id, toolId)),
      );
      if (!tool)
        return fenceToolResult({ status: 'failed', summary: 'This tool is not available.' });
      if (run.signal.aborted) {
        run.called.push({ actionId: '', tool: tool.name, risk: tool.risk, state: 'cancelled' });
        return fenceToolResult({
          status: 'cancelled',
          summary: 'The run was stopped; nothing was done.',
        });
      }
      run.calls += 1;
      const parsed = sanitizeToolSchema(tool.inputSchema, { trusted: tool.source === 'builtin' });
      const checked = parsed.ok ? validateAgainstSchema(parsed.schema, input) : null;
      if (!checked?.ok) {
        const issues =
          checked && !checked.ok ? checked.issues : [{ path: '/', message: 'Invalid.' }];
        run.called.push({ actionId: '', tool: tool.name, risk: tool.risk, state: 'invalid' });
        await this.step(run, tool.name, 'error', {
          decision: 'invalid',
          issues: issues.map((i) => `${i.path}: ${i.message}`).slice(0, 5),
        });
        return fenceToolResult({
          status: 'invalid_arguments',
          summary: `The request did not have the expected details (${issues
            .map((i) => `${i.path.replace(/^\//, '') || 'request'}: ${i.message}`)
            .slice(0, 3)
            .join('; ')}). Ask the customer for what is missing.`,
        });
      }
      const args = checked.value as Record<string, JsonValue>;
      const hashHex = canonicalHash(args);
      const cacheKey = `${tool.id}:${hashHex}`;
      const previous = run.results.get(cacheKey);
      if (previous) return previous;
      const result = await this.handle(run, tool, args, Buffer.from(hashHex, 'hex'), started);
      run.results.set(cacheKey, result);
      return result;
    });
  }

  private async handle(
    run: RunTools,
    tool: ToolRow,
    args: Record<string, JsonValue>,
    hash: Buffer,
    started: number,
  ): Promise<FencedToolResult> {
    const ctx = run.context;
    const now = this.clock();
    const scope: ToolScope = {
      tenantId: ctx.tenantId,
      brandId: ctx.brandId,
      conversationId: ctx.conversationId,
      principalId: ctx.principalId,
    };
    const grant = ctx.config.tools.grants.find((g) => fromPublicId('tool', g.toolId) === tool.id);
    const proposed = await this.tx(ctx.tenantId, async (tx) => {
      // Revalidated now, not at the start of the run (X02): the conversation must still be the
      // AI's at the run's epoch. The lock also serializes this conversation's budget.
      const control = await this.ownership.lock(tx, ctx.conversationId);
      if (control.ownerMode !== 'AI_ACTIVE' || control.ownershipEpoch !== ctx.epoch) {
        return { kind: 'fenced' as const };
      }
      const [existing] = await tx
        .select()
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.runId, ctx.runId),
            eq(schema.actions.toolId, tool.id),
            eq(schema.actions.argumentsHash, hash),
          ),
        );
      // The same call in a retried run: the action already exists and is not proposed twice.
      if (existing) return { kind: 'existing' as const, action: existing };
      const [current] = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(eq(schema.toolDefinitions.id, tool.id));
      if (!current) return { kind: 'fenced' as const };
      const stopped = await this.switches.activeFor(tx, {
        brandId: ctx.brandId,
        agentId: ctx.agentId,
        toolId: tool.id,
      });
      // The tenant budget is counted under a lock on the tenant's settings row.
      await tx
        .insert(schema.actionSettings)
        .values({ tenantId: ctx.tenantId })
        .onConflictDoNothing();
      const [settings] = await tx.select().from(schema.actionSettings).for('update');
      const [conversationCount] = await tx
        .select({ n: count() })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.conversationId, ctx.conversationId),
            eq(schema.actions.basis, 'autopilot'),
          ),
        );
      const [tenantCount] = await tx
        .select({ n: count() })
        .from(schema.actions)
        .where(
          and(
            eq(schema.actions.basis, 'autopilot'),
            gt(schema.actions.createdAt, new Date(now.getTime() - 24 * 60 * 60_000)),
          ),
        );
      const prepared = await this.adapters.prepare(tx, current, args, scope);
      const decision = prepared.ok
        ? decideExecution({
            risk: current.risk,
            approver: current.approver,
            status: current.status,
            stopped: stopped !== null,
            autopilot: {
              tool: current.autopilot,
              grant: grant?.autopilot ?? false,
              tenant: settings?.autopilotEnabled ?? true,
            },
            run: { used: run.calls - 1, max: ctx.config.tools.maxCallsPerRun },
            conversation: {
              used: conversationCount?.n ?? 0,
              max: ctx.config.tools.maxAutopilotPerConversation,
            },
            tenant: { used: tenantCount?.n ?? 0, max: settings?.dailyAutopilotLimit ?? 0 },
            untrustedContext: run.untrusted,
            customerPresent: ctx.principalId !== null,
          })
        : ({ kind: 'deny', reason: 'resource_not_found' } as const);
      const proposal = prepared.ok ? prepared.proposal : null;
      const approver = decision.kind === 'approval' ? decision.approver : current.approver;
      const state: ActionState =
        decision.kind === 'execute'
          ? 'approved'
          : decision.kind === 'approval'
            ? 'awaiting_approval'
            : 'denied';
      const id = newId();
      const publicId = toPublicId('action', id);
      const [action] = await tx
        .insert(schema.actions)
        .values({
          id,
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          agentId: ctx.agentId,
          agentVersionId: ctx.agentVersionId,
          toolId: current.id,
          toolRevision: current.revision,
          toolName: current.name,
          toolTitle: current.title,
          risk: current.risk,
          approver,
          requiredPermission: current.requiredPermission,
          stepUp: approvalNeedsStepUp({
            risk: current.risk,
            approver,
            customerStepUp: current.customerStepUp,
          }),
          state,
          basis:
            decision.kind === 'execute'
              ? 'autopilot'
              : decision.kind === 'approval'
                ? 'approval'
                : 'refused',
          reason: decision.kind === 'execute' ? null : decision.reason,
          arguments: args,
          argumentsHash: hash,
          summary: (
            proposal?.summary ?? `${current.title}: ${prepared.ok ? '' : prepared.summary}`
          ).slice(0, 500),
          effects: proposal?.effects ?? [],
          changes: proposal?.changes ?? [],
          amountMinor: proposal?.amount?.amountMinor ?? null,
          currency: proposal?.amount?.currency ?? null,
          resourceType: proposal?.resource?.type ?? null,
          resourceId: proposal?.resource?.id ?? null,
          resourceLabel: proposal?.resource?.label ?? null,
          resourceRevision: proposal?.resource?.revision ?? null,
          ownerEpoch: ctx.epoch,
          principalId: ctx.principalId,
          code:
            decision.kind === 'approval' && approver === 'customer' ? actionCode(publicId) : null,
          expiresAt:
            decision.kind === 'approval'
              ? approvalExpiry(now, approver, current.approvalMinutes ?? undefined)
              : null,
          decidedAt: decision.kind === 'execute' ? now : null,
        })
        .onConflictDoNothing()
        .returning();
      if (!action) return { kind: 'fenced' as const };
      if (decision.kind === 'approval' && approver === 'customer') {
        const [brand] = await tx
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(eq(schema.brands.id, ctx.brandId));
        await this.cards.enqueue(
          tx,
          ctx.tenantId,
          control,
          approvalPublication(action, brand?.name ?? 'Support', ctx.agentDisplayName),
          `approval:${action.id}`,
        );
      }
      await appendAudit(tx, {
        actorType: 'system',
        actorId: 'ai',
        action: decision.kind === 'deny' ? 'ai.action.denied' : 'ai.action.proposed',
        targetType: 'action',
        targetId: publicId,
        outcome: decision.kind === 'deny' ? 'denied' : 'success',
        occurredAt: now,
        data: {
          tool: current.name,
          risk: current.risk,
          decision: decision.kind,
          ...(decision.kind !== 'execute' ? { reason: decision.reason } : {}),
          argumentsHash: hash.toString('hex'),
          run: toPublicId('run', ctx.runId),
        },
      });
      return {
        kind: decision.kind,
        action,
        reason: decision.kind === 'execute' ? null : decision.reason,
        prepared,
      };
    });

    if (proposed.kind === 'existing') {
      return this.resume(run, tool, proposed.action);
    }
    if (proposed.kind === 'fenced') {
      run.called.push({ actionId: '', tool: tool.name, risk: tool.risk, state: 'fenced' });
      await this.step(run, tool.name, 'skipped', { decision: 'fenced' }, { inputHash: hash });
      return fenceToolResult({
        status: 'cancelled',
        summary: 'This conversation is now handled by a person; nothing was done.',
      });
    }
    const action = proposed.action;
    const actionId = toPublicId('action', action.id);
    const latency = () => Date.now() - started;
    const stepDetail = {
      actionId,
      risk: action.risk,
      decision: proposed.kind,
      ...(proposed.reason ? { reason: proposed.reason } : {}),
    };
    if (proposed.kind === 'deny') {
      run.called.push({ actionId, tool: tool.name, risk: tool.risk, state: 'denied' });
      await this.step(run, tool.name, 'blocked', stepDetail, {
        latencyMs: latency(),
        inputHash: hash,
      });
      const prepared = proposed.prepared;
      return fenceToolResult({
        status: 'denied',
        summary:
          proposed.reason === 'resource_not_found' && !prepared.ok
            ? prepared.summary
            : (REASON_TEXT[proposed.reason ?? ''] ?? 'This action is not allowed.'),
        actionId,
      });
    }
    if (proposed.kind === 'approval') {
      run.called.push({ actionId, tool: tool.name, risk: tool.risk, state: 'awaiting_approval' });
      await this.step(run, tool.name, 'ok', stepDetail, { latencyMs: latency(), inputHash: hash });
      return fenceToolResult({
        status: 'awaiting_approval',
        summary:
          action.approver === 'customer'
            ? `Approval requested: ${action.summary}. The customer approves or declines it in the chat.`
            : `Approval requested: ${action.summary}. A team member has to approve it first.`,
        actionId,
      });
    }

    // Autopilot: a lookup runs here; a change goes through the operation ledger.
    let state: ActionState;
    let summary: string;
    let output: unknown;
    if (action.risk === 'read') {
      try {
        const outcome = await this.adapters.execute(tool, args, scope, {
          idempotencyKey: `hv-action-${action.id}`,
          signal: AbortSignal.any([run.signal, AbortSignal.timeout(tool.timeoutMs)]),
        });
        state = outcome.status === 'succeeded' ? 'completed' : 'failed';
        summary = outcome.summary;
        output = outcome.status === 'succeeded' ? outcome.output : undefined;
      } catch (error) {
        state = 'failed';
        summary =
          error instanceof ToolCallFailure && error.kind === 'timeout'
            ? `${tool.title}: the tool did not answer in time.`
            : `${tool.title}: the tool could not be reached.`;
      }
      await this.tx(ctx.tenantId, async (tx) => {
        await tx
          .update(schema.actions)
          .set({
            state,
            outcomeSummary: summary.slice(0, 500),
            completedAt: this.clock(),
            updatedAt: this.clock(),
          })
          .where(eq(schema.actions.id, action.id));
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'ai',
          action: state === 'completed' ? 'ai.action.executed' : 'ai.action.failed',
          targetType: 'action',
          targetId: actionId,
          outcome: state === 'completed' ? 'success' : 'failed',
          data: { tool: tool.name, risk: tool.risk, autopilot: true },
        });
      });
    } else {
      const executed = await this.executor.execute(ctx.tenantId, action.id, {
        signal: run.signal,
        runId: ctx.runId,
      });
      state = executed.state;
      summary = executed.summary;
      output = executed.output;
    }
    if (tool.source === 'mcp') run.untrusted = true;
    run.called.push({ actionId, tool: tool.name, risk: tool.risk, state });
    const contained =
      output === undefined ? null : containToolOutput(output, { maxBytes: tool.maxOutputBytes });
    const status: ToolResultStatus =
      state === 'completed'
        ? action.risk === 'read'
          ? contained?.ok === false
            ? 'failed'
            : 'ok'
          : 'completed'
        : state === 'unknown'
          ? 'unknown'
          : state === 'cancelled' || state === 'superseded'
            ? 'cancelled'
            : 'failed';
    await this.step(
      run,
      tool.name,
      state === 'completed' ? 'ok' : 'error',
      {
        ...stepDetail,
        outcome: state,
        ...(contained ? { outputBytes: contained.bytes } : {}),
        ...(contained && !contained.ok ? { contained: contained.reason } : {}),
      },
      {
        latencyMs: latency(),
        inputHash: hash,
        ...(contained?.ok ? { outputHash: sha256(JSON.stringify(contained.data)) } : {}),
      },
    );
    return fenceToolResult({
      status,
      summary:
        contained && !contained.ok && action.risk === 'read'
          ? `${tool.title}: the answer could not be used (${contained.reason.replace('_', ' ')}).`
          : summary,
      ...(contained?.ok ? { data: contained.data } : {}),
      actionId,
    });
  }

  /** The result of an action this run already proposed (a retried run), from its record. */
  private async resume(
    run: RunTools,
    tool: ToolRow,
    action: typeof schema.actions.$inferSelect,
  ): Promise<FencedToolResult> {
    const actionId = toPublicId('action', action.id);
    let state = action.state;
    let summary = action.outcomeSummary ?? action.summary;
    if (state === 'approved' && action.basis === 'autopilot' && action.risk !== 'read') {
      const executed = await this.executor.execute(run.context.tenantId, action.id, {
        signal: run.signal,
        runId: run.context.runId,
      });
      state = executed.state;
      summary = executed.summary;
    }
    run.called.push({ actionId, tool: tool.name, risk: tool.risk, state });
    const status: ToolResultStatus =
      state === 'awaiting_approval'
        ? 'awaiting_approval'
        : state === 'denied'
          ? 'denied'
          : state === 'completed'
            ? action.risk === 'read'
              ? 'ok'
              : 'completed'
            : state === 'executing' || state === 'unknown' || state === 'approved'
              ? 'unknown'
              : state === 'failed'
                ? 'failed'
                : 'cancelled';
    return fenceToolResult({
      status,
      summary:
        status === 'awaiting_approval'
          ? `Approval requested: ${summary}.`
          : status === 'denied'
            ? (REASON_TEXT[action.reason ?? ''] ?? 'This action is not allowed.')
            : summary,
      actionId,
    });
  }

  /**
   * What the conversation's actions establish, for the receipt check on a reply (G14): a change
   * counts only with a succeeded receipt in the operation ledger, a lookup only when it completed.
   */
  async evidence(tenantId: string, conversationId: string): Promise<ActionEvidence> {
    return this.tx(tenantId, async (tx) => {
      const a = schema.actions;
      const r = schema.operationReceipts;
      const rows = await tx
        .select({
          state: a.state,
          risk: a.risk,
          receipted: sql<boolean>`exists (select 1 from ${r} where ${r.operationId} = ${a.operationId} and ${r.outcome} = 'succeeded')`,
        })
        .from(a)
        .where(eq(a.conversationId, conversationId));
      return {
        completedChanges: rows.filter(
          (row) => row.state === 'completed' && row.risk !== 'read' && row.receipted,
        ).length,
        completedLookups: rows.filter((row) => row.state === 'completed' && row.risk === 'read')
          .length,
        pending: rows.filter((row) => PENDING_STATES.has(row.state)).length,
      };
    });
  }
}
