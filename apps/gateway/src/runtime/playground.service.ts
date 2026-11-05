import {
  AgentConfig,
  type ModelChoice,
  type PlaygroundAction,
  type PlaygroundResult,
  type PlaygroundSource,
  type PlaygroundStep,
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
import { detectHumanRequest } from '@hamnivo/domain';
import {
  ACTION_CLAIM_CORRECTION,
  canonicalHash,
  checkActionClaims,
  decideExecution,
  type FencedToolResult,
  fenceToolResult,
  findActionClaims,
  sanitizeToolSchema,
  toJsonSchema,
  validateAgainstSchema,
} from '@hamnivo/domain/actions';
import { checkCompletionClaims, findCompletionClaims } from '@hamnivo/domain/commerce';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import {
  dynamicTool,
  generateText,
  isStepCount,
  jsonSchema,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { eq } from 'drizzle-orm';
import type { ToolRow } from '../actions/adapters.js';
import { REASON_TEXT } from '../actions/views.js';
import { reservationSize } from '../billing/ai-credits.service.js';
import { CLAIM_CORRECTION } from '../commerce/claims.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { type Passage, RetrievalService } from '../knowledge/retrieval.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { checkHonesty } from './honesty.js';
import { ModelFactory } from './models.js';
import { PlaygroundLimiter } from './playground-limit.js';
import { applyCitations, systemPrompt } from './prompt.js';
import { classifyModelError } from './replies.service.js';

type Version = 'draft' | 'published';
type ToolRowT = ToolRow;

/** Passages given to the model, as in a live reply. */
const PASSAGES = 6;
/** Kinds where another model may still answer; a bad request would fail there too. */
const FALLBACK_KINDS = new Set(['rate_limited', 'overloaded', 'unavailable', 'timeout']);
const HONESTY_CORRECTION =
  'Your previous draft claimed to be a person. You are an AI assistant; say so if it matters.';
const TEST_NOTE =
  'This is a test conversation. Tools are not called, so nothing can be looked up or changed. ' +
  'Say what you would need, or that you cannot check, instead of inventing a result.';

const excerptOf = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 280 ? flat : `${flat.slice(0, 277)}…`;
};

/** The steps of one turn, in order, in the shape a live run records them. */
class StepLog {
  readonly steps: PlaygroundStep[] = [];
  add(
    step: Omit<
      PlaygroundStep,
      'seq' | 'provider' | 'modelId' | 'inputTokens' | 'outputTokens' | 'latencyMs'
    > &
      Partial<
        Pick<PlaygroundStep, 'provider' | 'modelId' | 'inputTokens' | 'outputTokens' | 'latencyMs'>
      >,
  ) {
    this.steps.push({
      provider: null,
      modelId: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: null,
      ...step,
      seq: this.steps.length,
    });
  }
}

interface Generated {
  text: string;
  provider: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** What the tools did in one turn, for the claims check and the list of actions. */
interface Tools {
  actions: PlaygroundAction[];
  calls: number;
  autopilot: number;
  pending: number;
}

const sum = (a: number | null, b: number | null) =>
  a === null && b === null ? null : (a ?? 0) + (b ?? 0);

/**
 * "Test your AI" (G03, G11): a person tries an agent in a scratch conversation, with the agent's
 * own model connection, its knowledge and its tools' rules, and sees what it would say and every
 * step it took. Nothing is stored (the conversation is kept by the tester and sent whole), no
 * customer, memory, earlier conversation or Chatwoot is involved, and no tool is ever run: a tool
 * the AI asks for is only judged by the live rules and shown. It spends tokens like any run, so
 * it counts toward the plan's and the budget's tokens, and each person has a limit of turns per
 * minute. What a person types is not recorded; the audit log keeps counts only.
 */
@Injectable()
export class PlaygroundService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly models: ModelFactory,
    private readonly retrieval: RetrievalService,
    private readonly limiter: PlaygroundLimiter,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private async load(principal: StaffPrincipal, agentId: string, which: Version) {
    return this.tx(principal, async (tx) => {
      let id: string;
      try {
        id = fromPublicId('agent', agentId);
      } catch {
        throw new AppError('NOT_FOUND', { detail: 'Agent not found.' });
      }
      const [profile] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, id));
      if (!profile) throw new AppError('NOT_FOUND', { detail: 'Agent not found.' });
      enforce(
        authorize(
          principal,
          'agents.manage',
          { workspaceId: profile.workspaceId, brandId: profile.brandId },
          { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
        ),
      );
      if (profile.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', { detail: 'This agent is archived.' });
      }
      const versions = await tx
        .select()
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.profileId, profile.id));
      const version =
        which === 'draft'
          ? versions.find((v) => v.state === 'draft')
          : versions.find((v) => v.id === profile.publishedVersionId);
      if (!version) {
        const detail =
          which === 'draft'
            ? 'There is no saved draft to try. Save a draft first.'
            : 'This agent has no live version yet.';
        throw new AppError('VALIDATION_FAILED', {
          detail,
          fields: [{ path: 'version', message: detail }],
        });
      }
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, profile.brandId));
      const tools = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(eq(schema.toolDefinitions.brandId, profile.brandId));
      const [settings] = await tx.select().from(schema.actionSettings);
      return {
        profile,
        version,
        config: AgentConfig.parse(version.config),
        brandName: brand?.name ?? 'this business',
        tools,
        autopilot: {
          enabled: settings?.autopilotEnabled ?? true,
          limit: settings?.dailyAutopilotLimit ?? 200,
        },
      };
    });
  }

  /** Passages from the agent's own knowledge for what was just asked (G05). */
  private async retrieve(
    principal: StaffPrincipal,
    brandId: string,
    config: AgentConfig,
    messages: { role: 'user' | 'assistant'; text: string }[],
    log: StepLog,
  ): Promise<Passage[]> {
    if (config.knowledgeSourceIds.length === 0) return [];
    const query = messages
      .filter((m) => m.role === 'user')
      .slice(-2)
      .map((m) => m.text.trim())
      .join('\n')
      .slice(-1000);
    // Public knowledge only, in every mode: an assist draft is sent as it is once approved
    // (HNV-09-05), so the preview cites only what the customer may see, as a live draft does.
    const audience = 'customer';
    const started = Date.now();
    const passages = await this.tx(principal, (tx) =>
      this.retrieval.search(tx, {
        brandId,
        sourceIds: config.knowledgeSourceIds.map((id) => fromPublicId('source', id)),
        audience,
        query,
        limit: PASSAGES,
      }),
    );
    log.add({
      kind: 'retrieval',
      name: 'knowledge',
      status: 'ok',
      latencyMs: Date.now() - started,
      detail: {
        audience,
        passages: passages.length,
        documents: [...new Set(passages.map((p) => toPublicId('document', p.documentId)))],
      },
    });
    return passages;
  }

  /** The tools the agent may use, each one only judged and shown, never run. */
  private toolSet(
    loaded: Awaited<ReturnType<PlaygroundService['load']>>,
    tools: Tools,
    log: StepLog,
  ): ToolSet {
    const { config } = loaded;
    const set: ToolSet = {};
    for (const grant of config.tools.grants) {
      const tool = loaded.tools.find(
        (t) => toPublicId('tool', t.id) === grant.toolId && t.status === 'enabled',
      );
      if (!tool) continue;
      const parsed = sanitizeToolSchema(tool.inputSchema, { trusted: tool.source === 'builtin' });
      if (!parsed.ok) continue;
      set[tool.name] = dynamicTool({
        description: tool.description,
        inputSchema: jsonSchema(toJsonSchema(parsed.schema) as Parameters<typeof jsonSchema>[0]),
        execute: async (input) => this.judge(loaded, tools, log, tool, grant.autopilot, input),
      });
    }
    return set;
  }

  /** One tool call: the live policy decides, the answer says that nothing was run. */
  private judge(
    loaded: Awaited<ReturnType<PlaygroundService['load']>>,
    tools: Tools,
    log: StepLog,
    tool: ToolRowT,
    grantAutopilot: boolean,
    input: unknown,
  ): FencedToolResult {
    const { config } = loaded;
    tools.calls += 1;
    const parsed = sanitizeToolSchema(tool.inputSchema, { trusted: tool.source === 'builtin' });
    const checked = parsed.ok ? validateAgainstSchema(parsed.schema, input) : null;
    const record = (
      decision: PlaygroundAction['decision'],
      reason: string | null,
      args: Record<string, unknown> | null,
      hash: string | null,
    ) => {
      tools.actions.push({ tool: tool.name, title: tool.title, decision, reason, arguments: args });
      log.add({
        kind: 'tool',
        name: tool.name,
        status: decision === 'would_run' || decision === 'needs_approval' ? 'ok' : 'blocked',
        detail: {
          decision,
          risk: tool.risk,
          approver: tool.approver,
          ...(reason ? { reason } : {}),
          ...(hash ? { argumentsHash: hash } : {}),
          run: false,
        },
      });
    };
    if (!checked?.ok) {
      record('invalid', 'arguments', null, null);
      return fenceToolResult({
        status: 'invalid_arguments',
        summary:
          'The request did not have the expected details. Ask the customer for what is missing.',
      });
    }
    const args = (checked.value ?? {}) as Record<string, unknown>;
    const argumentsHash = canonicalHash(checked.value);
    const decision = decideExecution({
      risk: tool.risk,
      approver: tool.approver,
      status: tool.status,
      stopped: false,
      autopilot: {
        tool: tool.autopilot,
        grant: grantAutopilot,
        tenant: loaded.autopilot.enabled,
      },
      run: { used: tools.calls - 1, max: config.tools.maxCallsPerRun },
      conversation: { used: tools.autopilot, max: config.tools.maxAutopilotPerConversation },
      tenant: { used: 0, max: loaded.autopilot.limit },
      untrustedContext: false,
      customerPresent: true,
    });
    if (decision.kind === 'deny') {
      record('denied', decision.reason, args, argumentsHash);
      return fenceToolResult({
        status: 'denied',
        summary: REASON_TEXT[decision.reason] ?? 'This action is not allowed.',
      });
    }
    if (decision.kind === 'approval') {
      tools.pending += 1;
      record('needs_approval', decision.reason, args, argumentsHash);
      return fenceToolResult({
        status: 'awaiting_approval',
        summary:
          decision.approver === 'customer'
            ? `Approval requested: ${tool.title}. The customer approves or declines it in the chat.`
            : `Approval requested: ${tool.title}. A team member has to approve it first.`,
      });
    }
    tools.autopilot += 1;
    record('would_run', null, args, argumentsHash);
    return fenceToolResult({
      status: 'failed',
      summary: `${tool.title}: this is a test, so the tool was not called. In a live chat it would run now.`,
    });
  }

  /** One model call within the agent's limits, trying fallbacks only when the main one is down. */
  private async callModels(
    tenantId: string,
    config: AgentConfig,
    system: string,
    messages: ModelMessage[],
    tools: ToolSet,
    log: StepLog,
    attempt: number,
    requestId: string,
  ): Promise<Generated> {
    const choices: ModelChoice[] = [config.model, ...config.fallbackModels];
    let lastKind = 'unavailable';
    for (const [index, choice] of choices.entries()) {
      if (config.model.connectionId && !choice.connectionId) continue;
      const started = Date.now();
      try {
        const { resolved, result } = await this.models.executeAttempt(
          tenantId,
          choice,
          {
            key: `playground:${requestId}:generate:${attempt}:model:${index}`,
            reserveTokens: reservationSize(system, messages, config.limits.maxOutputTokens, 1),
            timeoutMs: config.limits.timeoutMs,
            attribution: { playgroundRequestId: requestId },
          },
          async (resolved) => ({
            resolved,
            result: await generateText({
              model: resolved.model,
              instructions: system,
              messages,
              ...(Object.keys(tools).length > 0 ? { tools } : {}),
              maxOutputTokens: config.limits.maxOutputTokens,
              stopWhen: isStepCount(config.limits.maxSteps),
              maxRetries: 0,
              abortSignal: AbortSignal.timeout(config.limits.timeoutMs),
            }),
          }),
        );
        const generated: Generated = {
          text: result.text.trim(),
          provider: resolved.provider,
          modelId: resolved.modelId,
          inputTokens: result.totalUsage.inputTokens ?? null,
          outputTokens: result.totalUsage.outputTokens ?? null,
        };
        log.add({
          kind: 'model',
          name: 'generate',
          status: 'ok',
          provider: generated.provider,
          modelId: generated.modelId,
          inputTokens: generated.inputTokens,
          outputTokens: generated.outputTokens,
          latencyMs: Date.now() - started,
          detail: {
            finishReason: result.finishReason,
            steps: result.steps.length,
            attempt,
            index,
          },
        });
        return generated;
      } catch (error) {
        // Admission errors retain their API status and quota details.
        if (
          error instanceof AppError &&
          ['PLAN_LIMIT_REACHED', 'QUOTA_EXCEEDED'].includes(error.code)
        )
          throw error;
        const failure = classifyModelError(error);
        lastKind = failure.kind;
        log.add({
          kind: 'model',
          name: 'generate',
          status: 'error',
          provider: choice.provider,
          modelId: choice.modelId,
          latencyMs: Date.now() - started,
          detail: { errorKind: failure.kind, attempt, index },
        });
        if (!FALLBACK_KINDS.has(failure.kind)) break;
      }
    }
    throw new ModelFailure(lastKind);
  }

  async run(
    principal: StaffPrincipal,
    agentId: string,
    input: { version: Version; messages: { role: 'user' | 'assistant'; text: string }[] },
  ): Promise<PlaygroundResult> {
    const loaded = await this.load(principal, agentId, input.version);
    await this.limiter.check(principal.staffMemberId);
    const requestId = newId();

    const { config, profile } = loaded;
    const log = new StepLog();
    const started = Date.now();
    const base = {
      version: { number: loaded.version.version, state: input.version },
      sources: [] as PlaygroundSource[],
      actions: [] as PlaygroundAction[],
    };
    const finish = async (
      result: Omit<PlaygroundResult, 'version' | 'latencyMs' | 'steps' | 'sources' | 'actions'> &
        Partial<Pick<PlaygroundResult, 'sources' | 'actions'>>,
    ): Promise<PlaygroundResult> => {
      const done: PlaygroundResult = {
        ...base,
        ...result,
        latencyMs: Date.now() - started,
        steps: log.steps,
      };
      await this.record(principal, agentId, done, input.messages.length);
      return done;
    };

    const question = input.messages.at(-1)?.text ?? '';
    if (detectHumanRequest(question).requested) {
      log.add({ kind: 'guard', name: 'human_request', status: 'ok', detail: { handoff: true } });
      return finish({
        outcome: 'handoff',
        reply: null,
        handoffReason: 'customer_request',
        errorKind: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      });
    }
    if (config.mode === 'assist') {
      log.add({
        kind: 'guard',
        name: 'assist_mode',
        status: 'ok',
        detail: {
          note: 'Live, this agent writes suggestions for staff and never answers customers.',
        },
      });
    }

    const passages = await this.retrieve(principal, profile.brandId, config, input.messages, log);
    const tools: Tools = { actions: [], calls: 0, autopilot: 0, pending: 0 };
    const toolSet = this.toolSet(loaded, tools, log);
    const history: ModelMessage[] = input.messages.map((m) => ({ role: m.role, content: m.text }));
    const system =
      `${systemPrompt(
        config,
        loaded.brandName,
        passages.map((p) => ({ title: p.title, heading: p.heading, text: p.text })),
        { tools: Object.keys(toolSet).length > 0 },
      )}\n\n${TEST_NOTE}` +
      (config.mode === 'assist'
        ? '\n\nYou are writing a suggested reply for a support agent to review. Write only the reply.'
        : '');

    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let model: { provider: string; modelId: string } | null = null;
    let reply: { text: string; cited: Passage[] } | null = null;
    let correction: string | null = null;
    try {
      for (let attempt = 0; attempt < 2 && reply === null; attempt += 1) {
        const generated = await this.callModels(
          principal.tenantId,
          config,
          correction ? `${system}\n\n${correction}` : system,
          history,
          toolSet,
          log,
          attempt,
          requestId,
        );
        model = { provider: generated.provider, modelId: generated.modelId };
        inputTokens = sum(inputTokens, generated.inputTokens);
        outputTokens = sum(outputTokens, generated.outputTokens);
        const cited = applyCitations(generated.text, passages, (p) => p.documentId);
        const text = cited.text;
        const honest = checkHonesty(text);
        log.add({
          kind: 'guard',
          name: 'honest_identity',
          status: honest.ok ? 'ok' : 'blocked',
          detail: honest.ok ? {} : { rule: honest.rule },
        });
        if (!honest.ok) {
          correction = HONESTY_CORRECTION;
          continue;
        }
        // No payment or refund can be confirmed here: there is no receipt in a scratch conversation.
        const completion = findCompletionClaims(text);
        if (completion.length > 0) {
          const verdict = checkCompletionClaims(text, {
            paymentConfirmed: false,
            refundConfirmed: false,
          });
          log.add({
            kind: 'guard',
            name: 'receipt_claims',
            status: verdict.ok ? 'ok' : 'blocked',
            detail: { claims: [...new Set(completion.map((c) => c.claim))] },
          });
          if (!verdict.ok) {
            correction = CLAIM_CORRECTION;
            continue;
          }
        }
        const claims = findActionClaims(text);
        if (claims.length > 0) {
          // A knowledge search counts as checking, as it does in a live reply.
          const verdict = checkActionClaims(text, {
            completedChanges: 0,
            completedLookups: passages.length > 0 ? 1 : 0,
            pending: tools.pending,
          });
          log.add({
            kind: 'guard',
            name: 'action_claims',
            status: verdict.ok ? 'ok' : 'blocked',
            detail: { claims: claims.map((c) => c.claim), rules: claims.map((c) => c.rule) },
          });
          if (!verdict.ok) {
            correction = ACTION_CLAIM_CORRECTION;
            continue;
          }
        }
        if (!text) throw new ModelFailure('empty_reply');
        reply = { text, cited: cited.cited };
      }
    } catch (error) {
      if (!(error instanceof ModelFailure)) throw error;
      return finish({
        outcome: 'error',
        reply: null,
        handoffReason: null,
        errorKind: error.kind,
        model,
        inputTokens,
        outputTokens,
        actions: tools.actions,
      });
    }
    if (reply === null) {
      return finish({
        outcome: 'blocked',
        reply: null,
        handoffReason: 'ai_blocked',
        errorKind: null,
        model,
        inputTokens,
        outputTokens,
        actions: tools.actions,
      });
    }
    return finish({
      outcome: 'replied',
      reply: reply.text,
      handoffReason: null,
      errorKind: null,
      model,
      inputTokens,
      outputTokens,
      sources: reply.cited.map((p) => ({
        documentId: toPublicId('document', p.documentId),
        title: p.title.slice(0, 300),
        heading: p.heading,
        url: p.url,
        excerpt: excerptOf(p.text),
      })),
      actions: tools.actions,
    });
  }

  /** The audit log keeps counts and the model, never what was typed or answered. */
  private async record(
    principal: StaffPrincipal,
    agentId: string,
    result: PlaygroundResult,
    messages: number,
  ): Promise<void> {
    await this.tx(principal, async (tx) => {
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'agent.playground.ran',
        targetType: 'agent',
        targetId: agentId,
        outcome: result.outcome === 'error' ? 'failed' : 'success',
        data: {
          version: result.version.number,
          state: result.version.state,
          outcome: result.outcome,
          ...(result.model
            ? { provider: result.model.provider, modelId: result.model.modelId }
            : {}),
          ...(result.errorKind ? { errorKind: result.errorKind } : {}),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          messages,
          sources: result.sources.length,
          actions: result.actions.length,
        },
      });
    });
  }
}

/** Every model the agent may use failed, or none gave text. */
class ModelFailure extends Error {
  constructor(readonly kind: string) {
    super(kind);
  }
}
