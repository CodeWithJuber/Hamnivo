import type { Action, McpServer, ToolDefinition } from '@hamnivo/contracts';
import { schema, toPublicId } from '@hamnivo/db';
import { iso } from '../common/views.js';

export type ActionRow = typeof schema.actions.$inferSelect;
export type ApprovalRow = typeof schema.actionApprovals.$inferSelect;
export type ReceiptRow = typeof schema.operationReceipts.$inferSelect;
type ToolRow = typeof schema.toolDefinitions.$inferSelect;
type ServerRow = typeof schema.mcpServers.$inferSelect;

/** Why an action did not run, in words safe for customers and staff. */
export const REASON_TEXT: Record<string, string> = {
  tool_disabled: 'This tool is turned off.',
  tool_in_review: 'This tool has not been reviewed yet.',
  tool_stopped: 'Actions with this tool are stopped for now.',
  run_limit: 'The AI reached its limit of tool calls for this message.',
  budget_exhausted: 'The AI reached its limit of automatic actions.',
  no_approver: 'There is nobody who can approve this here.',
  resource_not_found: 'What the action is about could not be found for this customer.',
  owner_changed: 'Someone else now handles this conversation, so the request was cancelled.',
  tool_changed: 'The tool changed after this was proposed, so it needs a new request.',
  grant_removed: 'The AI may no longer use this tool, so the request was cancelled.',
  resource_changed: 'The details changed after this was proposed, so it needs a new request.',
  arguments_changed: 'The request changed after it was shown.',
  run_cancelled: 'The AI run was stopped before this was sent.',
  declined: 'The request was declined.',
  expired: 'Nobody approved this in time.',
  policy: 'This needs approval first.',
  budget: 'This needs approval because the automatic limit was reached.',
  untrusted_context:
    'This needs approval because it was proposed after reading data from another system.',
};

export function toolView(row: ToolRow, stopped: boolean): ToolDefinition {
  return {
    id: toPublicId('tool', row.id),
    brandId: toPublicId('brand', row.brandId),
    name: row.name,
    title: row.title,
    description: row.description,
    remoteDescription: row.remoteDescription,
    source: row.source,
    builtin: row.builtin,
    mcpServerId: row.mcpServerId ? toPublicId('mcpServer', row.mcpServerId) : null,
    inputSchema: row.inputSchema,
    outputSchema: row.outputSchema,
    risk: row.risk,
    approver: row.approver,
    requiredPermission: row.requiredPermission,
    autopilot: row.autopilot,
    customerStepUp: row.customerStepUp,
    resourceType: row.resourceType,
    timeoutMs: row.timeoutMs,
    maxOutputBytes: row.maxOutputBytes,
    egressHosts: row.egressHosts,
    amountArgument: row.amountArgument,
    currencyArgument: row.currencyArgument,
    approvalMinutes: row.approvalMinutes,
    status: row.status,
    stopped,
    revision: row.revision,
    reviewedAt: iso(row.reviewedAt),
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy ? toPublicId('staff', row.updatedBy) : null,
  };
}

export function serverView(
  row: ServerRow,
  counts: { tools: number; review: number },
  masked: string | null,
): McpServer {
  return {
    id: toPublicId('mcpServer', row.id),
    brandId: toPublicId('brand', row.brandId),
    label: row.label,
    url: row.url,
    status: row.status,
    credential: masked ? { masked } : null,
    protocolVersion: row.protocolVersion,
    serverName: row.serverName,
    toolCount: counts.tools,
    pendingReview: counts.review,
    lastSyncedAt: iso(row.lastSyncedAt),
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function actionView(
  row: ActionRow,
  context: {
    approval?: ApprovalRow | null;
    receipt?: ReceiptRow | null;
    /** Staff see the arguments and the reason codes behind them. */
    staff: boolean;
  },
): Action {
  const approval = context.approval ?? null;
  const receipt = context.receipt ?? null;
  const decision =
    approval !== null
      ? {
          decision: approval.decision,
          approverKind: approval.approverKind,
          at: approval.decidedAt.toISOString(),
        }
      : row.basis === 'autopilot' && row.decidedAt
        ? {
            decision: 'approved' as const,
            approverKind: 'autopilot' as const,
            at: row.decidedAt.toISOString(),
          }
        : null;
  return {
    id: toPublicId('action', row.id),
    conversationId: toPublicId('conversation', row.conversationId),
    runId: row.runId ? toPublicId('run', row.runId) : null,
    tool: { id: toPublicId('tool', row.toolId), name: row.toolName, title: row.toolTitle },
    state: row.state,
    risk: row.risk,
    approver: row.approver,
    summary: row.summary,
    effects: row.effects,
    changes: row.changes,
    amount:
      row.amountMinor !== null && row.currency
        ? { amountMinor: row.amountMinor.toString(), currency: row.currency }
        : null,
    resource:
      row.resourceType && row.resourceId
        ? {
            type: row.resourceType,
            id: row.resourceId,
            label: row.resourceLabel ?? row.resourceId,
            revision: row.resourceRevision,
          }
        : null,
    argumentsHash: row.argumentsHash.toString('hex'),
    // An action that asks the customer to confirm who they are cannot be approved by text.
    code: row.stepUp ? null : row.code,
    stepUp: row.stepUp,
    reason: row.reason ? (REASON_TEXT[row.reason] ?? row.reason) : null,
    outcome: row.outcomeSummary,
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
    decision,
    receipt: receipt
      ? {
          id: toPublicId('receipt', receipt.id),
          outcome: receipt.outcome,
          reference: receipt.providerRef,
          source: receipt.source,
          observedAt: receipt.observedAt.toISOString(),
        }
      : null,
    operationId: row.operationId ? toPublicId('operation', row.operationId) : null,
    ...(context.staff ? { arguments: row.arguments } : {}),
  };
}
