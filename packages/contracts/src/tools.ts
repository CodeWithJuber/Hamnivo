import { z } from 'zod';
import { CurrencyCode, MinorUnits, Timestamp } from './common.js';
import { typeId } from './ids.js';

/**
 * Tools, AI actions, approvals and receipts (G07, G10, G11, G13–G15, D10, W16). A tool is defined
 * per brand with its input schema, risk class, approver, autopilot allowance, limits and egress
 * hosts; an action is one call the AI proposed, with the exact arguments an approver sees and the
 * receipt of what happened. Descriptions that come from MCP servers are untrusted text and are
 * shown quoted, never used as instructions.
 */

export const RiskClass = z.enum(['read', 'write', 'money', 'irreversible']).meta({
  id: 'RiskClass',
  description: 'What a tool can do: look, change, move money, or undo nothing',
});
export type RiskClass = z.infer<typeof RiskClass>;

export const ActionApprover = z.enum(['customer', 'staff']).meta({ id: 'ActionApprover' });
export type ActionApprover = z.infer<typeof ActionApprover>;

export const ToolStatus = z.enum(['enabled', 'disabled', 'review']).meta({
  id: 'ToolStatus',
  description: '`review`: discovered from an MCP server, not yet reviewed',
});

/** A JSON Schema in the portable subset (object at the root; see @hamnivo/domain/actions). */
export const ToolSchema = z.record(z.string(), z.unknown()).meta({ id: 'ToolSchema' });

export const BuiltinToolKey = z
  .enum(['order_status', 'demo_update_address', 'demo_issue_credit', 'read_resource'])
  .meta({ id: 'BuiltinToolKey' });
export type BuiltinToolKey = z.infer<typeof BuiltinToolKey>;

const ToolName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Lowercase letters, digits and underscores');

const Host = z
  .string()
  .regex(
    /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Expected a host name such as orders.example.com or *.example.com',
  );

export const ToolDefinition = z
  .object({
    id: typeId('tool'),
    brandId: typeId('brand'),
    name: ToolName,
    title: z.string(),
    /** Written by the workspace (or Hamnivo for built-ins); shown to the model. */
    description: z.string(),
    /** What the MCP server said about the tool: untrusted, shown quoted, never sent as is. */
    remoteDescription: z.string().nullable(),
    source: z.enum(['builtin', 'mcp', 'http', 'native']),
    builtin: BuiltinToolKey.nullable(),
    mcpServerId: typeId('mcpServer').nullable(),
    inputSchema: ToolSchema,
    /** What the tool promises to return; a result that does not match is refused. */
    outputSchema: ToolSchema.nullable(),
    risk: RiskClass,
    approver: ActionApprover,
    /** A permission staff approvers need as well as tools.approve. */
    requiredPermission: z.string().nullable(),
    autopilot: z.boolean(),
    customerStepUp: z.boolean(),
    /** What the tool acts on, e.g. `order`. */
    resourceType: z.string().nullable(),
    timeoutMs: z.int(),
    maxOutputBytes: z.int(),
    /** Hosts this tool may reach (tenant allowlist); empty for tools that make no network call. */
    egressHosts: z.array(z.string()),
    /** Arguments shown as the amount on approval cards. */
    amountArgument: z.string().nullable(),
    currencyArgument: z.string().nullable(),
    approvalMinutes: z.int().nullable(),
    status: ToolStatus,
    /** A tool kill switch is active. */
    stopped: z.boolean(),
    revision: z.int().positive(),
    reviewedAt: Timestamp.nullable(),
    updatedAt: Timestamp,
    updatedBy: typeId('staff').nullable(),
  })
  .meta({ id: 'ToolDefinition' });
export type ToolDefinition = z.infer<typeof ToolDefinition>;

/** The editable policy of a tool. */
export const ToolPolicyFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000),
  risk: RiskClass,
  approver: ActionApprover,
  requiredPermission: z.string().trim().min(3).max(80).nullable(),
  autopilot: z.boolean(),
  customerStepUp: z.boolean(),
  timeoutMs: z.int().min(1000).max(60_000),
  maxOutputBytes: z.int().min(256).max(262_144),
  egressHosts: z.array(Host).max(20),
  amountArgument: z.string().max(64).nullable(),
  currencyArgument: z.string().max(64).nullable(),
  approvalMinutes: z
    .int()
    .min(1)
    .max(7 * 24 * 60)
    .nullable(),
});

/** Adds a built-in tool to a brand, optionally with policy changes (tools.manage). */
export const CreateToolRequest = z
  .object({ brandId: typeId('brand'), builtin: BuiltinToolKey })
  .extend(ToolPolicyFields.partial().shape)
  .meta({ id: 'CreateToolRequest' });

/** Changes a tool's policy; every change bumps the revision and invalidates pending approvals. */
export const UpdateToolRequest = z
  .object({
    expectedRevision: z.int().positive(),
    status: ToolStatus.exclude(['review']).optional(),
  })
  .extend(ToolPolicyFields.partial().shape)
  .meta({ id: 'UpdateToolRequest' });

export const BuiltinTool = z
  .object({
    key: BuiltinToolKey,
    title: z.string(),
    description: z.string(),
    risk: RiskClass,
    approver: ActionApprover,
    autopilot: z.boolean(),
    resourceType: z.string().nullable(),
    /** Demo tools use an in-memory store and are offered only where demo tools are allowed. */
    demo: z.boolean(),
    available: z.boolean(),
  })
  .meta({ id: 'BuiltinTool' });
export type BuiltinTool = z.infer<typeof BuiltinTool>;

export const McpServer = z
  .object({
    id: typeId('mcpServer'),
    brandId: typeId('brand'),
    label: z.string(),
    url: z.string(),
    status: z.enum(['active', 'disabled']),
    /** A pasted token, sent as a bearer token; only its last characters are shown. */
    credential: z.object({ masked: z.string() }).nullable(),
    /** How requests to the server are signed in (a pasted token, or an OAuth sign-in). */
    auth: z.object({
      kind: z.enum(['none', 'token', 'oauth']),
      /** OAuth only: `needs_reconnect` when the saved sign-in stopped working. */
      status: z.enum(['connected', 'needs_reconnect']).nullable(),
      /** OAuth only: the host of the service that signs people in. */
      authorizationHost: z.string().nullable(),
      /** OAuth only: when the access token stops working, if the service said. */
      expiresAt: Timestamp.nullable(),
      scope: z.string().nullable(),
    }),
    protocolVersion: z.string().nullable(),
    serverName: z.string().nullable(),
    toolCount: z.int(),
    pendingReview: z.int(),
    lastSyncedAt: Timestamp.nullable(),
    /** Why the last sync failed, in safe words (never a raw response). */
    lastError: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'McpServer' });
export type McpServer = z.infer<typeof McpServer>;

export const CreateMcpServerRequest = z
  .object({
    brandId: typeId('brand'),
    label: z.string().trim().min(1).max(80),
    /** Streamable HTTP endpoint; HTTPS only. */
    url: z.url({ protocol: /^https?$/ }).max(500),
    token: z.string().trim().min(8).max(4000).optional(),
  })
  .meta({ id: 'CreateMcpServerRequest' });

export const UpdateMcpServerRequest = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    /**
     * A new address. Its tools go back to review and what it lists is read again. A pasted token
     * stays only when the new address is on the same site, and an OAuth sign-in always ends (it
     * was made for the old address): a credential is never sent to another site.
     */
    url: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    status: z.enum(['active', 'disabled']).optional(),
    /** A new token replaces the stored one (and ends an OAuth sign-in); null removes it. */
    token: z.string().trim().min(8).max(4000).nullable().optional(),
  })
  .meta({ id: 'UpdateMcpServerRequest' });

export const McpSyncResult = z
  .object({
    server: McpServer,
    added: z.array(z.string()),
    changed: z.array(z.string()),
    removed: z.array(z.string()),
    /** Tools the server offered that cannot be represented safely, with the reason. */
    skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
  })
  .meta({ id: 'McpSyncResult' });
export type McpSyncResult = z.infer<typeof McpSyncResult>;

export const ActionSettings = z
  .object({
    autopilotEnabled: z.boolean(),
    /** Autopilot actions the whole tenant may take per day (G15 tenant budget). */
    dailyAutopilotLimit: z.int().min(0).max(100_000),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'ActionSettings' });
export type ActionSettings = z.infer<typeof ActionSettings>;

export const UpdateActionSettingsRequest = z
  .object({
    autopilotEnabled: z.boolean().optional(),
    dailyAutopilotLimit: z.int().min(0).max(100_000).optional(),
  })
  .meta({ id: 'UpdateActionSettingsRequest' });

export const ActionState = z
  .enum([
    'awaiting_approval',
    'approved',
    'executing',
    'completed',
    'failed',
    'unknown',
    'declined',
    'expired',
    'superseded',
    'cancelled',
    'denied',
  ])
  .meta({ id: 'ActionState' });
export type ActionState = z.infer<typeof ActionState>;

export const ActionChange = z.object({
  field: z.string().max(120),
  from: z.string().max(300).nullable(),
  to: z.string().max(300),
});

/** One AI action as the customer (their own) or staff see it. */
export const Action = z
  .object({
    id: typeId('action'),
    conversationId: typeId('conversation'),
    runId: typeId('run').nullable(),
    tool: z.object({ id: typeId('tool'), name: z.string(), title: z.string() }),
    state: ActionState,
    risk: RiskClass,
    approver: ActionApprover,
    /** Plain wording of what will happen, from Hamnivo's records (never model text). */
    summary: z.string(),
    effects: z.array(z.string()),
    changes: z.array(ActionChange),
    amount: z.object({ amountMinor: MinorUnits, currency: CurrencyCode }).nullable(),
    resource: z
      .object({
        type: z.string(),
        id: z.string(),
        label: z.string(),
        revision: z.string().nullable(),
      })
      .nullable(),
    /** SHA-256 of the canonical arguments: what an approval binds to. */
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Code for approving by text on channels without cards. */
    code: z.string().nullable(),
    /** Approving needs a fresh sign-in (staff) or a fresh identity check (customer). */
    stepUp: z.boolean(),
    /** Why a refused or superseded action did not run, in safe words. */
    reason: z.string().nullable(),
    /** What the tool's answer established, in Hamnivo's words (never the tool's own text). */
    outcome: z.string().nullable(),
    expiresAt: Timestamp.nullable(),
    createdAt: Timestamp,
    decision: z
      .object({
        decision: z.enum(['approved', 'declined']),
        approverKind: z.enum(['customer', 'staff', 'autopilot']),
        at: Timestamp,
      })
      .nullable(),
    receipt: z
      .object({
        id: typeId('receipt'),
        outcome: z.enum(['pending', 'succeeded', 'failed', 'unknown']),
        reference: z.string().nullable(),
        source: z.enum(['provider_api', 'provider_webhook', 'reconciler', 'staff']),
        observedAt: Timestamp,
      })
      .nullable(),
    operationId: typeId('operation').nullable(),
    /** Staff only: the arguments themselves. */
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'Action' });
export type Action = z.infer<typeof Action>;

export const DecideActionRequest = z
  .object({
    decision: z.enum(['approve', 'decline']),
    /** The hash shown on the card; a different current hash refuses the decision. */
    argumentsHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** Makes a repeated tap safe: the same id returns the same decision. */
    clientRequestId: z.uuid(),
    reason: z.string().trim().max(300).optional(),
  })
  .meta({ id: 'DecideActionRequest' });

/**
 * A person checked the system an action went to and records its result: for a tool Hamnivo
 * cannot check itself (an MCP server has no standard status lookup). Nothing is sent again.
 */
export const ResolveActionRequest = z
  .object({
    outcome: z.enum(['succeeded', 'failed']),
    /** What the person saw, for the audit trail (no secrets). */
    note: z.string().trim().min(3).max(300),
  })
  .meta({ id: 'ResolveActionRequest' });

export const HandoffPacket = z
  .object({
    id: typeId('handoff'),
    conversationId: typeId('conversation'),
    epoch: z.int(),
    reason: z.string(),
    reasonText: z.string(),
    request: z.string().nullable(),
    replyLanguage: z.string().nullable(),
    attempts: z.array(
      z.object({
        kind: z.enum(['knowledge', 'tool', 'guard', 'model', 'decision']),
        label: z.string(),
        outcome: z.string(),
      }),
    ),
    pending: z.array(
      z.object({
        actionId: z.string(),
        title: z.string(),
        state: z.enum(['awaiting_approval', 'approved', 'executing', 'unknown', 'superseded']),
        approver: ActionApprover.nullable(),
        expiresAt: Timestamp.nullable(),
      }),
    ),
    facts: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        source: z.object({
          kind: z.enum(['tool', 'memory', 'identity', 'language', 'order']),
          ref: z.string().nullable(),
          observedAt: Timestamp.nullable(),
        }),
      }),
    ),
    createdAt: Timestamp,
  })
  .meta({ id: 'HandoffPacket' });
export type HandoffPacket = z.infer<typeof HandoffPacket>;

const Decision = z.enum(['executed', 'approval', 'denied', 'invalid', 'failed']);
const Outcome = z.enum(['replied', 'handoff', 'blocked', 'error']);

export const SimulationCase = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    name: z.string().trim().min(1).max(120),
    /** Customer messages, replayed in order. */
    messages: z.array(z.string().trim().min(1).max(2000)).min(1).max(10),
    /** What each tool (by name) answers in this case; unlisted tools fail. */
    tools: z
      .record(
        ToolName,
        z.object({
          output: z.unknown().optional(),
          error: z.enum(['timeout', 'failed', 'timeout_after_success']).optional(),
        }),
      )
      .default({}),
    expect: z
      .object({
        outcome: Outcome.optional(),
        actions: z
          .array(z.object({ tool: ToolName, decision: Decision }))
          .max(10)
          .optional(),
      })
      .optional(),
  })
  .meta({ id: 'SimulationCase' });
export type SimulationCase = z.infer<typeof SimulationCase>;

export const SimulationSuite = z
  .object({
    id: typeId('simulation'),
    agentId: typeId('agent'),
    name: z.string(),
    /** Publishing is blocked until the draft passes this suite. */
    required: z.boolean(),
    cases: z.array(SimulationCase),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'SimulationSuite' });
export type SimulationSuite = z.infer<typeof SimulationSuite>;

export const SaveSimulationSuiteRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    required: z.boolean().default(false),
    cases: z.array(SimulationCase).min(1).max(20),
  })
  .superRefine((value, ctx) => {
    const ids = value.cases.map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['cases'], message: 'Case ids must be unique' });
    }
  })
  .meta({ id: 'SaveSimulationSuiteRequest' });

const CaseResult = z.object({
  outcome: Outcome,
  handoffReason: z.string().nullable(),
  replies: z.array(z.string()),
  actions: z.array(
    z.object({
      tool: z.string(),
      decision: Decision,
      argumentsHash: z.string().nullable(),
      reason: z.string().nullable(),
    }),
  ),
});

export const SimulationRun = z
  .object({
    id: typeId('simulationRun'),
    suiteId: typeId('simulation'),
    agentId: typeId('agent'),
    candidateVersion: z.int().positive(),
    baselineVersion: z.int().positive().nullable(),
    /** SHA-256 of the draft configuration the run checked. */
    candidateConfigHash: z.string(),
    status: z.enum(['passed', 'failed']),
    summary: z.object({
      cases: z.int(),
      changed: z.int(),
      failed: z.int(),
      passed: z.boolean(),
    }),
    results: z.array(
      z.object({
        caseId: z.string(),
        name: z.string(),
        candidate: CaseResult,
        baseline: CaseResult.nullable(),
        changes: z.array(z.string()),
        failures: z.array(z.string()),
      }),
    ),
    startedAt: Timestamp,
    finishedAt: Timestamp,
    createdBy: typeId('staff').nullable(),
  })
  .meta({ id: 'SimulationRun' });
export type SimulationRun = z.infer<typeof SimulationRun>;
