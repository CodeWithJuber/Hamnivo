/**
 * Action policy of a tool (G07, G13, G15): its risk class, who approves it and whether it may run
 * on autopilot. The rules are fixed in code so no configuration, model output or tool output can
 * loosen them: money and irreversible actions are always approved by staff after a fresh sign-in
 * and never run on autopilot, and a customer can approve only their own low-risk requests.
 */

export const RISK_CLASSES = ['read', 'write', 'money', 'irreversible'] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const APPROVERS = ['customer', 'staff'] as const;
export type Approver = (typeof APPROVERS)[number];

export const TOOL_STATUSES = ['enabled', 'disabled', 'review'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

export interface ToolPolicy {
  risk: RiskClass;
  /** Who approves when the action does not run on autopilot. */
  approver: Approver;
  /** Allowlisted for autopilot: runs without approval within budgets. */
  autopilot: boolean;
  /**
   * A customer approving must confirm who they are first: a verified identity from the website,
   * signed in within the last few minutes (the widget asks the website for a fresh sign-in).
   */
  customerStepUp: boolean;
}

/** Money and irreversible actions: staff approval, a fresh sign-in, never autopilot. */
export const isHighRisk = (risk: RiskClass): boolean => risk === 'money' || risk === 'irreversible';

/** Whether this risk changes anything (and so goes through the operation ledger). */
export const isWrite = (risk: RiskClass): boolean => risk !== 'read';

export interface PolicyProblem {
  path: 'risk' | 'approver' | 'autopilot' | 'customerStepUp';
  message: string;
}

/** What is wrong with a policy, if anything (shown next to the field in Studio). */
export function toolPolicyProblems(policy: ToolPolicy): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (isHighRisk(policy.risk) && policy.approver !== 'staff') {
    problems.push({
      path: 'approver',
      message: 'Money and irreversible actions must be approved by staff.',
    });
  }
  if (isHighRisk(policy.risk) && policy.autopilot) {
    problems.push({
      path: 'autopilot',
      message: 'Money and irreversible actions never run without approval.',
    });
  }
  if (policy.customerStepUp && policy.approver !== 'customer') {
    problems.push({
      path: 'customerStepUp',
      message: 'Only actions a customer approves can ask the customer to confirm who they are.',
    });
  }
  return problems;
}

/** Whether approving needs a fresh sign-in: staff for high risk, customers when the tool says so. */
export function approvalNeedsStepUp(
  policy: Pick<ToolPolicy, 'risk' | 'approver' | 'customerStepUp'>,
) {
  return policy.approver === 'staff' ? isHighRisk(policy.risk) : policy.customerStepUp;
}
