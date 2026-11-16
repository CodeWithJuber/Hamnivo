import { z } from 'zod';
import { LanguageTag, Timestamp } from './common.js';
import { typeId } from './ids.js';

export const ModelProviderKind = z
  .enum(['anthropic', 'openai', 'google', 'openai-compatible', 'mock'])
  .meta({ id: 'ModelProviderKind' });
export type ModelProviderKind = z.infer<typeof ModelProviderKind>;

/** Which model generates an agent's text, and whose credentials pay for it. */
export const ModelChoice = z
  .object({
    provider: ModelProviderKind,
    modelId: z.string().trim().min(1).max(200),
    /** Tenant credentials. Omitted: the platform's key for this provider, when one is configured. */
    connectionId: typeId('modelConnection').optional(),
  })
  .meta({ id: 'ModelChoice' });
export type ModelChoice = z.infer<typeof ModelChoice>;

/** Hard ceilings for one run (G09). A run that reaches one stops and hands off honestly. */
export const AgentLimits = z
  .object({
    maxOutputTokens: z.int().min(16).max(8192).default(600),
    timeoutMs: z.int().min(1000).max(120_000).default(30_000),
    /** Customer-visible messages given to the model as context. */
    historyMessages: z.int().min(1).max(100).default(20),
    maxSteps: z.int().min(1).max(10).default(4),
  })
  .meta({ id: 'AgentLimits' });

/**
 * Customer memory for this agent (G19). When on, the agent proposes what customers ask it to
 * remember and uses what is remembered, but only for customers who agreed; the memory-write
 * policy decides what is stored.
 */
export const AgentMemory = z
  .object({
    enabled: z.boolean().default(false),
    /** Memories given to the model for one reply. */
    maxItems: z.int().min(1).max(20).default(8),
    /** Characters of memories given to the model for one reply. */
    maxChars: z.int().min(100).max(4000).default(1200),
  })
  .meta({ id: 'AgentMemory' });

/** One tool the agent may call (G07). The tool's own policy decides approval and autopilot. */
export const AgentToolGrant = z
  .object({
    toolId: typeId('tool'),
    /** Off: this agent always asks for approval, even where the tool may run on autopilot. */
    autopilot: z.boolean().default(true),
  })
  .meta({ id: 'AgentToolGrant' });

/** Tools granted to the agent and its action budgets (G15). */
export const AgentTools = z
  .object({
    grants: z.array(AgentToolGrant).max(30).default([]),
    /** Tool calls in one run, whatever their kind. */
    maxCallsPerRun: z.int().min(1).max(10).default(4),
    /** Autopilot actions in one conversation; beyond it, changes wait for approval. */
    maxAutopilotPerConversation: z.int().min(0).max(50).default(5),
  })
  .superRefine((value, ctx) => {
    const ids = value.grants.map((g) => g.toolId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['grants'], message: 'Each tool can be granted once' });
    }
  })
  .meta({ id: 'AgentTools' });

/**
 * Everything that decides how an agent behaves. A published version of it never changes; edits
 * create a new draft (A07).
 */
export const AgentConfig = z
  .object({
    /**
     * Name customers see next to every AI message. It describes the role (e.g. "Hamnivo
     * assistant") and never pretends to be a person (U09).
     */
    displayName: z.string().trim().min(1).max(60),
    purpose: z.string().trim().max(2000).default(''),
    /** Business instructions. Honesty and safety rules are added by Hamnivo and cannot be removed. */
    instructions: z.string().max(20_000).default(''),
    tone: z.enum(['warm', 'neutral', 'formal']).default('warm'),
    /** Reply languages. A customer writing in another language is offered a person. */
    languages: z.array(LanguageTag).min(1).max(20).default(['en']),
    /**
     * `answer`: replies to customers. `assist`: writes suggestions for staff as internal notes and
     * never replies to customers (G03).
     */
    mode: z.enum(['answer', 'assist']).default('answer'),
    model: ModelChoice,
    /** Tried in order when the main model is overloaded or unavailable, never after partial output. */
    fallbackModels: z.array(ModelChoice).max(2).default([]),
    limits: AgentLimits.prefault({}),
    /** Knowledge the agent answers from. Customer answers use only public sources (G05). */
    knowledgeSourceIds: z.array(typeId('source')).max(20).default([]),
    memory: AgentMemory.prefault({}),
    /** Tools the agent may call and its action budgets (G07, G15). */
    tools: AgentTools.prefault({}),
  })
  .meta({ id: 'AgentConfig' });
export type AgentConfig = z.output<typeof AgentConfig>;

export const AgentStatus = z.enum(['active', 'archived']);

export const Agent = z
  .object({
    id: typeId('agent'),
    workspaceId: typeId('workspace'),
    brandId: typeId('brand'),
    name: z.string(),
    status: AgentStatus,
    /** The brand's default agent answers the brand's conversations. */
    isDefault: z.boolean(),
    publishedVersion: z.int().positive().nullable(),
    draftVersion: z.int().positive().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Agent' });
export type Agent = z.infer<typeof Agent>;

export const AgentVersion = z
  .object({
    id: typeId('agentVersion'),
    agentId: typeId('agent'),
    version: z.int().positive(),
    state: z.enum(['draft', 'published', 'retired']),
    config: AgentConfig,
    /** SHA-256 of the canonical configuration, fixed when first published. */
    configHash: z.string().nullable(),
    createdAt: Timestamp,
    publishedAt: Timestamp.nullable(),
    publishedBy: typeId('staff').nullable(),
    /**
     * When the version last changed: a draft's last save, or when a version went live (also
     * again, by a rollback) or was retired. With it Studio says how long the live version has been
     * live and which version was live before it (HNV-11-06).
     */
    updatedAt: Timestamp,
  })
  .meta({ id: 'AgentVersion' });
export type AgentVersion = z.infer<typeof AgentVersion>;

export const AgentDetail = z
  .object({
    agent: Agent,
    published: AgentVersion.nullable(),
    draft: AgentVersion.nullable(),
  })
  .meta({ id: 'AgentDetail' });
export type AgentDetail = z.infer<typeof AgentDetail>;

export const CreateAgentRequest = z
  .object({
    brandId: typeId('brand'),
    name: z.string().trim().min(1).max(80),
    isDefault: z.boolean().default(false),
    config: AgentConfig,
  })
  .meta({ id: 'CreateAgentRequest' });

export const UpdateAgentRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    isDefault: z.boolean().optional(),
    status: AgentStatus.optional(),
  })
  .meta({ id: 'UpdateAgentRequest' });

export const SaveAgentDraftRequest = z
  .object({
    config: AgentConfig,
    /** The draft version you edited; a newer draft means someone else saved first (409). */
    baseVersion: z.int().positive().optional(),
  })
  .meta({ id: 'SaveAgentDraftRequest' });

export const PublishAgentRequest = z
  .object({
    /** A draft to publish, or an earlier version to restore (rollback). Default: the draft. */
    version: z.int().positive().optional(),
  })
  .meta({ id: 'PublishAgentRequest' });

/** Make the assistant live in one step: a real model, the brand's knowledge, memory, publish. */
export const GoLiveAgentRequest = z
  .object({
    /** The workspace key to use. Default: its newest active key, else the platform's. */
    connectionId: typeId('modelConnection').optional(),
  })
  .meta({ id: 'GoLiveAgentRequest' });

export const ModelConnection = z
  .object({
    id: typeId('modelConnection'),
    provider: ModelProviderKind.exclude(['mock']),
    label: z.string(),
    baseUrl: z.string().nullable(),
    /** Model IDs agents may use with these credentials; empty allows any. */
    allowedModels: z.array(z.string()),
    status: z.enum(['active', 'disabled']),
    /** Last characters of the API key, for recognition. The key itself is never returned. */
    keyHint: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: 'ModelConnection' });
export type ModelConnection = z.infer<typeof ModelConnection>;

export const CreateModelConnectionRequest = z
  .object({
    provider: ModelProviderKind.exclude(['mock']),
    label: z.string().trim().min(1).max(80),
    /** Required for OpenAI-compatible servers; optional proxy or region endpoint otherwise. */
    baseUrl: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    apiKey: z.string().trim().min(8).max(1000),
    allowedModels: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'openai-compatible' && !value.baseUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['baseUrl'],
        message: 'OpenAI-compatible servers need a base URL',
      });
    }
  })
  .meta({ id: 'CreateModelConnectionRequest' });

export const KillSwitchScope = z.enum(['tenant', 'brand', 'agent', 'tool']);

/**
 * Stops AI replies in its scope; people keep chatting and see the conversation (X08). A `tool`
 * switch stops that tool's actions only: the AI keeps answering and is told the tool is stopped.
 */
export const KillSwitch = z
  .object({
    id: typeId('killSwitch'),
    scope: KillSwitchScope,
    /** brd_…, agt_… or tool_…; null for the whole tenant. */
    targetId: z.string().nullable(),
    reason: z.string(),
    active: z.boolean(),
    createdAt: Timestamp,
    createdBy: typeId('staff').nullable(),
    clearedAt: Timestamp.nullable(),
  })
  .meta({ id: 'KillSwitch' });
export type KillSwitch = z.infer<typeof KillSwitch>;

export const CreateKillSwitchRequest = z
  .object({
    scope: KillSwitchScope,
    targetId: z.string().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .superRefine((value, ctx) => {
    const prefix = { tenant: null, brand: 'brd_', agent: 'agt_', tool: 'tool_' }[value.scope];
    if (prefix === null ? value.targetId !== undefined : !value.targetId?.startsWith(prefix)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetId'],
        message:
          prefix === null ? 'A tenant switch has no target' : `Expected a ${prefix}… identifier`,
      });
    }
  })
  .meta({ id: 'CreateKillSwitchRequest' });

export const RunStep = z
  .object({
    seq: z.int().nonnegative(),
    kind: z.enum(['model', 'guard', 'decision', 'retrieval', 'tool']),
    name: z.string(),
    status: z.enum(['ok', 'error', 'blocked', 'skipped']),
    provider: z.string().nullable(),
    modelId: z.string().nullable(),
    inputTokens: z.int().nullable(),
    outputTokens: z.int().nullable(),
    latencyMs: z.int().nullable(),
    /** Non-sensitive facts only: finish reason, error kind, which rule matched. No prompt text. */
    detail: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'RunStep' });

/** Telemetry of one AI run (G12, X11). Holds no prompt or reply text. */
export const Run = z
  .object({
    id: typeId('run'),
    conversationId: typeId('conversation'),
    agentId: typeId('agent').nullable(),
    agentVersion: z.int().positive().nullable(),
    kind: z.enum(['reply', 'draft', 'guard']),
    state: z.enum(['running', 'succeeded', 'failed', 'skipped']),
    outcome: z
      .enum(['replied', 'drafted', 'handoff', 'fenced', 'blocked', 'error', 'skipped', 'cancelled'])
      .nullable(),
    provider: z.string().nullable(),
    modelId: z.string().nullable(),
    inputTokens: z.int().nullable(),
    outputTokens: z.int().nullable(),
    latencyMs: z.int().nullable(),
    errorKind: z.string().nullable(),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    steps: z.array(RunStep).optional(),
  })
  .meta({ id: 'Run' });
export type Run = z.infer<typeof Run>;
