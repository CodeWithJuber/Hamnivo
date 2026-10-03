import { createMockModel } from '@hamnivo/adapters/models';
import {
  AgentConfig,
  type SaveSimulationSuiteRequest,
  SimulationCase,
  type SimulationRun,
  type SimulationSuite,
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
import { detectHumanRequest } from '@hamnivo/domain';
import {
  ACTION_CLAIM_CORRECTION,
  type CaseComparison,
  type CaseResult,
  canonicalHash,
  checkActionClaims,
  compareCase,
  decideExecution,
  type FencedToolResult,
  fenceToolResult,
  type SimulatedAction,
  type SimulationCase as SimulationCaseT,
  sanitizeToolSchema,
  summarizeSimulation,
  toJsonSchema,
  validateAgainstSchema,
} from '@hamnivo/domain/actions';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import {
  dynamicTool,
  generateText,
  isStepCount,
  jsonSchema,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { configHash } from '../runtime/agents.service.js';
import { checkHonesty } from '../runtime/honesty.js';
import { systemPrompt } from '../runtime/prompt.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { containOutput, returnsUntrustedData, type ToolRow } from './adapters.js';
import { REASON_TEXT } from './views.js';

type SuiteRow = typeof schema.simulationSuites.$inferSelect;
type RunRow = typeof schema.simulationRuns.$inferSelect;
type VersionRow = typeof schema.agentVersions.$inferSelect;

const CORRECTION =
  'Your previous draft claimed to be a person. You are an AI assistant; say so if it matters.';

function suiteView(row: SuiteRow): SimulationSuite {
  return {
    id: toPublicId('simulation', row.id),
    agentId: toPublicId('agent', row.agentId),
    name: row.name,
    required: row.required,
    cases: SimulationCase.array().parse(row.cases),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runView(row: RunRow, versions: Map<string, number>): SimulationRun {
  return {
    id: toPublicId('simulationRun', row.id),
    suiteId: toPublicId('simulation', row.suiteId),
    agentId: toPublicId('agent', row.agentId),
    candidateVersion: versions.get(row.candidateVersionId) ?? 1,
    baselineVersion: row.baselineVersionId ? (versions.get(row.baselineVersionId) ?? null) : null,
    candidateConfigHash: row.candidateConfigHash.toString('hex'),
    status: row.status,
    summary: row.summary as SimulationRun['summary'],
    results: row.results as SimulationRun['results'],
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    createdBy: row.createdBy ? toPublicId('staff', row.createdBy) : null,
  };
}

/** What a simulated conversation can prove about its own actions (for the claims check). */
interface Simulated {
  actions: SimulatedAction[];
  changes: number;
  lookups: number;
  pending: number;
  untrusted: boolean;
  calls: number;
  autopilot: number;
}

/**
 * Simulation and replay (G11, HNV-11-04, HNV-11-05). Canned conversations run against the draft
 * and the published version of an agent with the deterministic mock model and the case's fake tool
 * answers, through the same tool schemas, policy decisions, containment and reply guards as live
 * runs. Nothing is sent, executed or stored as a conversation; the comparison shows what the draft
 * changes. A suite marked required blocks publishing until the exact draft passes it.
 */
@Injectable()
export class SimulationService {
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

  private async agent(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
  ) {
    const [profile] = await tx
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, fromPublicId('agent', publicId)));
    if (!profile) throw new AppError('NOT_FOUND', { detail: 'Agent not found.' });
    enforce(
      authorize(
        principal,
        permission,
        { workspaceId: profile.workspaceId, brandId: profile.brandId },
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
      ),
    );
    return profile;
  }

  private async suite(tx: TenantTx, agentId: string, publicId: string) {
    const [row] = await tx
      .select()
      .from(schema.simulationSuites)
      .where(
        and(
          eq(schema.simulationSuites.id, fromPublicId('simulation', publicId)),
          eq(schema.simulationSuites.agentId, agentId),
        ),
      );
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Simulation suite not found.' });
    return row;
  }

  async listSuites(principal: StaffPrincipal, agentId: string): Promise<SimulationSuite[]> {
    return this.tx(principal, async (tx) => {
      const profile = await this.agent(tx, principal, agentId, 'agents.read');
      const rows = await tx
        .select()
        .from(schema.simulationSuites)
        .where(eq(schema.simulationSuites.agentId, profile.id))
        .orderBy(schema.simulationSuites.createdAt);
      return rows.map(suiteView);
    });
  }

  async saveSuite(
    principal: StaffPrincipal,
    agentId: string,
    suiteId: string | null,
    input: z.output<typeof SaveSimulationSuiteRequest>,
  ): Promise<SimulationSuite> {
    return this.tx(principal, async (tx) => {
      const profile = await this.agent(tx, principal, agentId, 'agents.manage');
      const now = this.clock();
      let row: SuiteRow | undefined;
      if (suiteId) {
        const existing = await this.suite(tx, profile.id, suiteId);
        [row] = await tx
          .update(schema.simulationSuites)
          .set({
            name: input.name,
            required: input.required,
            cases: input.cases,
            updatedBy: principal.staffMemberId,
            updatedAt: now,
          })
          .where(eq(schema.simulationSuites.id, existing.id))
          .returning();
      } else {
        [row] = await tx
          .insert(schema.simulationSuites)
          .values({
            tenantId: principal.tenantId,
            agentId: profile.id,
            name: input.name,
            required: input.required,
            cases: input.cases,
            createdBy: principal.staffMemberId,
            updatedBy: principal.staffMemberId,
          })
          .returning();
      }
      if (!row) throw new Error('suite save returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: suiteId ? 'agent.simulation_suite.updated' : 'agent.simulation_suite.created',
        targetType: 'agent',
        targetId: agentId,
        outcome: 'success',
        data: {
          suite: toPublicId('simulation', row.id),
          cases: input.cases.length,
          required: input.required,
        },
      });
      return suiteView(row);
    });
  }

  async deleteSuite(principal: StaffPrincipal, agentId: string, suiteId: string): Promise<void> {
    await this.tx(principal, async (tx) => {
      const profile = await this.agent(tx, principal, agentId, 'agents.manage');
      const row = await this.suite(tx, profile.id, suiteId);
      await tx.delete(schema.simulationRuns).where(eq(schema.simulationRuns.suiteId, row.id));
      await tx.delete(schema.simulationSuites).where(eq(schema.simulationSuites.id, row.id));
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'agent.simulation_suite.deleted',
        targetType: 'agent',
        targetId: agentId,
        outcome: 'success',
        data: { suite: suiteId },
      });
    });
  }

  private async versionNumbers(tx: TenantTx, rows: RunRow[]) {
    const ids = [
      ...new Set(
        rows.flatMap((r) => [
          r.candidateVersionId,
          ...(r.baselineVersionId ? [r.baselineVersionId] : []),
        ]),
      ),
    ];
    if (ids.length === 0) return new Map<string, number>();
    const versions = await tx
      .select({ id: schema.agentVersions.id, version: schema.agentVersions.version })
      .from(schema.agentVersions)
      .where(inArray(schema.agentVersions.id, ids));
    return new Map(versions.map((v) => [v.id, v.version]));
  }

  async listRuns(
    principal: StaffPrincipal,
    agentId: string,
    suiteId: string,
  ): Promise<SimulationRun[]> {
    return this.tx(principal, async (tx) => {
      const profile = await this.agent(tx, principal, agentId, 'agents.read');
      const suite = await this.suite(tx, profile.id, suiteId);
      const rows = await tx
        .select()
        .from(schema.simulationRuns)
        .where(eq(schema.simulationRuns.suiteId, suite.id))
        .orderBy(desc(schema.simulationRuns.startedAt))
        .limit(10);
      const versions = await this.versionNumbers(tx, rows);
      return rows.map((row) => runView(row, versions));
    });
  }

  /** Replays a suite: the draft against the published version, case by case. */
  async run(principal: StaffPrincipal, agentId: string, suiteId: string): Promise<SimulationRun> {
    const loaded = await this.tx(principal, async (tx) => {
      const profile = await this.agent(tx, principal, agentId, 'agents.manage');
      const suite = await this.suite(tx, profile.id, suiteId);
      const versions = await tx
        .select()
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.profileId, profile.id));
      const draft = versions.find((v) => v.state === 'draft');
      if (!draft) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'There is no draft to simulate. Save a draft first.',
          fields: [{ path: 'draft', message: 'No draft' }],
        });
      }
      const published = versions.find((v) => v.id === profile.publishedVersionId) ?? null;
      const tools = await tx
        .select()
        .from(schema.toolDefinitions)
        .where(eq(schema.toolDefinitions.brandId, profile.brandId));
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, profile.brandId));
      const [settings] = await tx.select().from(schema.actionSettings);
      return {
        profile,
        suite,
        draft,
        published,
        tools,
        brandName: brand?.name ?? 'this business',
        settings,
      };
    });
    const startedAt = this.clock();
    const cases = SimulationCase.array().parse(loaded.suite.cases);
    const autopilot = {
      enabled: loaded.settings?.autopilotEnabled ?? true,
      limit: loaded.settings?.dailyAutopilotLimit ?? 200,
    };
    const results: CaseComparison[] = [];
    for (const definition of cases) {
      const candidate = await this.simulate(
        loaded.draft,
        definition,
        loaded.tools,
        loaded.brandName,
        autopilot,
      );
      const baseline = loaded.published
        ? await this.simulate(
            loaded.published,
            definition,
            loaded.tools,
            loaded.brandName,
            autopilot,
          )
        : null;
      results.push(compareCase(definition as SimulationCaseT, candidate, baseline));
    }
    const summary = summarizeSimulation(results);
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .insert(schema.simulationRuns)
        .values({
          tenantId: principal.tenantId,
          suiteId: loaded.suite.id,
          agentId: loaded.profile.id,
          candidateVersionId: loaded.draft.id,
          baselineVersionId: loaded.published?.id ?? null,
          candidateConfigHash: configHash(AgentConfig.parse(loaded.draft.config)),
          status: summary.passed ? 'passed' : 'failed',
          summary: summary as unknown as Record<string, unknown>,
          results: results as unknown as Record<string, unknown>[],
          startedAt,
          finishedAt: this.clock(),
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!row) throw new Error('simulation run insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'agent.simulation.ran',
        targetType: 'agent',
        targetId: agentId,
        outcome: summary.passed ? 'success' : 'failed',
        data: { suite: suiteId, version: loaded.draft.version, ...summary },
      });
      return runView(row, await this.versionNumbers(tx, [row]));
    });
  }

  /** One canned conversation against one agent version. */
  private async simulate(
    version: VersionRow,
    definition: z.output<typeof SimulationCase>,
    tools: ToolRow[],
    brandName: string,
    autopilot: { enabled: boolean; limit: number },
  ): Promise<CaseResult> {
    const config = AgentConfig.parse(version.config);
    const replies: string[] = [];
    const state: Simulated = {
      actions: [],
      changes: 0,
      lookups: 0,
      pending: 0,
      untrusted: false,
      calls: 0,
      autopilot: 0,
    };
    const granted = config.tools.grants.flatMap((grant) => {
      const tool = tools.find(
        (t) => toPublicId('tool', t.id) === grant.toolId && t.status === 'enabled',
      );
      return tool ? [{ tool, grant }] : [];
    });
    const messages: ModelMessage[] = [];
    const model = createMockModel();
    try {
      for (const text of definition.messages) {
        messages.push({ role: 'user', content: text });
        if (detectHumanRequest(text).requested) {
          return {
            outcome: 'handoff',
            handoffReason: 'customer_request',
            replies,
            actions: state.actions,
          };
        }
        if (config.mode !== 'answer') {
          return {
            outcome: 'handoff',
            handoffReason: 'assist_mode',
            replies,
            actions: state.actions,
          };
        }
        state.calls = 0;
        const toolSet: ToolSet = {};
        for (const { tool, grant } of granted) {
          const parsed = sanitizeToolSchema(tool.inputSchema, {
            trusted: tool.source === 'builtin',
          });
          if (!parsed.ok) continue;
          toolSet[tool.name] = dynamicTool({
            description: tool.description,
            inputSchema: jsonSchema(
              toJsonSchema(parsed.schema) as Parameters<typeof jsonSchema>[0],
            ),
            execute: async (input) =>
              this.simulateCall(state, tool, grant.autopilot, input, definition, config, autopilot),
          });
        }
        const base = systemPrompt(config, brandName, [], {
          tools: Object.keys(toolSet).length > 0,
        });
        let reply: string | null = null;
        let correction: string | null = null;
        for (let attempt = 0; attempt < 2 && reply === null; attempt += 1) {
          const result = await generateText({
            model,
            instructions: correction ? `${base}\n\n${correction}` : base,
            messages,
            ...(Object.keys(toolSet).length ? { tools: toolSet } : {}),
            stopWhen: isStepCount(config.limits.maxSteps),
            maxRetries: 0,
          });
          const candidate = result.text.trim();
          if (!checkHonesty(candidate).ok) {
            correction = CORRECTION;
            continue;
          }
          const claims = checkActionClaims(candidate, {
            completedChanges: state.changes,
            completedLookups: state.lookups,
            pending: state.pending,
          });
          if (!claims.ok) {
            correction = ACTION_CLAIM_CORRECTION;
            continue;
          }
          reply = candidate;
        }
        if (reply === null) {
          return {
            outcome: 'blocked',
            handoffReason: 'ai_blocked',
            replies,
            actions: state.actions,
          };
        }
        replies.push(reply);
        messages.push({ role: 'assistant', content: reply });
      }
      return { outcome: 'replied', handoffReason: null, replies, actions: state.actions };
    } catch {
      return { outcome: 'error', handoffReason: null, replies, actions: state.actions };
    }
  }

  /** A tool call in a simulation: the live policy, the case's fake answer, nothing executed. */
  private simulateCall(
    state: Simulated,
    tool: ToolRow,
    grantAutopilot: boolean,
    input: unknown,
    definition: z.output<typeof SimulationCase>,
    config: AgentConfig,
    autopilot: { enabled: boolean; limit: number },
  ): FencedToolResult {
    state.calls += 1;
    const parsed = sanitizeToolSchema(tool.inputSchema, { trusted: tool.source === 'builtin' });
    const checked = parsed.ok ? validateAgainstSchema(parsed.schema, input) : null;
    if (!checked?.ok) {
      state.actions.push({
        tool: tool.name,
        decision: 'invalid',
        argumentsHash: null,
        reason: 'arguments',
      });
      return fenceToolResult({
        status: 'invalid_arguments',
        summary:
          'The request did not have the expected details. Ask the customer for what is missing.',
      });
    }
    const argumentsHash = canonicalHash(checked.value);
    const decision = decideExecution({
      risk: tool.risk,
      approver: tool.approver,
      status: tool.status,
      stopped: false,
      autopilot: { tool: tool.autopilot, grant: grantAutopilot, tenant: autopilot.enabled },
      run: { used: state.calls - 1, max: config.tools.maxCallsPerRun },
      conversation: { used: state.autopilot, max: config.tools.maxAutopilotPerConversation },
      tenant: { used: 0, max: autopilot.limit },
      untrustedContext: state.untrusted,
      customerPresent: true,
    });
    if (decision.kind === 'deny') {
      state.actions.push({
        tool: tool.name,
        decision: 'denied',
        argumentsHash,
        reason: decision.reason,
      });
      return fenceToolResult({
        status: 'denied',
        summary: REASON_TEXT[decision.reason] ?? 'This action is not allowed.',
      });
    }
    if (decision.kind === 'approval') {
      state.pending += 1;
      state.actions.push({
        tool: tool.name,
        decision: 'approval',
        argumentsHash,
        reason: decision.reason,
      });
      return fenceToolResult({
        status: 'awaiting_approval',
        summary:
          decision.approver === 'customer'
            ? `Approval requested: ${tool.title}. The customer approves or declines it in the chat.`
            : `Approval requested: ${tool.title}. A team member has to approve it first.`,
      });
    }
    state.autopilot += 1;
    const fake = definition.tools[tool.name];
    if (returnsUntrustedData(tool)) state.untrusted = true;
    if (!fake || fake.error === 'failed' || fake.error === 'timeout') {
      state.actions.push({
        tool: tool.name,
        decision: 'failed',
        argumentsHash,
        reason: fake?.error ?? 'no_answer_in_case',
      });
      return fenceToolResult({
        status: fake?.error === 'timeout' && tool.risk !== 'read' ? 'unknown' : 'failed',
        summary: `${tool.title}: the tool did not give an answer.`,
      });
    }
    if (fake.error === 'timeout_after_success') {
      state.pending += 1;
      state.actions.push({
        tool: tool.name,
        decision: 'executed',
        argumentsHash,
        reason: 'outcome_unknown',
      });
      return fenceToolResult({
        status: 'unknown',
        summary: `${tool.title}: the request was sent, but the result is not confirmed.`,
      });
    }
    const contained = containOutput(tool, fake.output ?? {});
    state.actions.push({
      tool: tool.name,
      decision: 'executed',
      argumentsHash,
      reason: contained.ok ? null : contained.reason,
    });
    if (tool.risk === 'read') state.lookups += 1;
    else state.changes += 1;
    return fenceToolResult({
      status: tool.risk === 'read' ? (contained.ok ? 'ok' : 'failed') : 'completed',
      summary: `${tool.title}: ${tool.risk === 'read' ? 'answer received' : 'done'}.`,
      ...(contained.ok ? { data: contained.data } : {}),
    });
  }
}
