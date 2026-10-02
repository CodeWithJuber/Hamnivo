import { type Approver, isHighRisk, type RiskClass, type ToolStatus } from './policy.js';

/**
 * What happens to a tool call the model makes (G08, G15, X02, X03, X08). The decision uses only
 * Hamnivo's records (tool status and policy, the agent's grant, kill switches, counters); nothing
 * the model or a tool said can change it. Autopilot runs only allowlisted read-only and low-risk
 * tools, within per-run, per-conversation and per-tenant budgets; everything else waits for the
 * approver the tool names, and a refused call is recorded with its reason.
 */

export interface Budget {
  used: number;
  max: number;
}

export interface ExecutionInput {
  risk: RiskClass;
  approver: Approver;
  status: ToolStatus;
  /** A kill switch stops this tool, the agent, the brand or the tenant. */
  stopped: boolean;
  /** Tool allowlisted for autopilot, agent grant allows it and the tenant has autopilot on. */
  autopilot: { tool: boolean; grant: boolean; tenant: boolean };
  /** Tool calls already made in this run (any kind). */
  run: Budget;
  /** Autopilot actions already taken in this conversation. */
  conversation: Budget;
  /** Autopilot actions already taken by the tenant in the current day. */
  tenant: Budget;
  /**
   * The run has read untrusted tool output (for example from an MCP server). A write proposed
   * after that may have been steered by it, so it waits for a person instead of running alone.
   */
  untrustedContext: boolean;
  /** There is a customer who can approve (their own request). */
  customerPresent: boolean;
}

export type DenyReason =
  | 'tool_disabled'
  | 'tool_in_review'
  | 'tool_stopped'
  | 'run_limit'
  | 'budget_exhausted'
  | 'no_approver';

export type ApprovalReason = 'policy' | 'budget' | 'untrusted_context';

export type ExecutionDecision =
  | { kind: 'execute' }
  | { kind: 'approval'; approver: Approver; reason: ApprovalReason }
  | { kind: 'deny'; reason: DenyReason };

const within = (budget: Budget) => budget.used < budget.max;

export function decideExecution(input: ExecutionInput): ExecutionDecision {
  if (input.status === 'review') return { kind: 'deny', reason: 'tool_in_review' };
  if (input.status !== 'enabled') return { kind: 'deny', reason: 'tool_disabled' };
  if (input.stopped) return { kind: 'deny', reason: 'tool_stopped' };
  if (!within(input.run)) return { kind: 'deny', reason: 'run_limit' };

  const approval = (reason: ApprovalReason): ExecutionDecision =>
    input.approver === 'customer' && !input.customerPresent
      ? { kind: 'deny', reason: 'no_approver' }
      : { kind: 'approval', approver: input.approver, reason };

  const eligible =
    !isHighRisk(input.risk) &&
    input.autopilot.tool &&
    input.autopilot.grant &&
    input.autopilot.tenant;
  if (!eligible) return approval('policy');
  if (input.risk === 'write' && input.untrustedContext) return approval('untrusted_context');
  if (!within(input.conversation) || !within(input.tenant)) {
    // A lookup beyond the budget is not worth a person's approval; a change still can be.
    return input.risk === 'read'
      ? { kind: 'deny', reason: 'budget_exhausted' }
      : approval('budget');
  }
  return { kind: 'execute' };
}
