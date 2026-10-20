/** Finite, readable workflows. Definitions contain data only; no expressions or executable code. */
export interface Predicate {
  field: string;
  op: 'is' | 'is_not' | 'contains';
  value: string | boolean | number;
}
export interface WorkflowValueReference {
  stepId: string;
  path: readonly (string | number)[];
}
export interface StepShape {
  id: string;
  type: string;
  next?: string | null;
  then?: string | null;
  otherwise?: string | null;
  agentId?: string;
  connectionId?: string;
  bindings?: Readonly<Record<string, WorkflowValueReference>>;
  queryFrom?: WorkflowValueReference;
  requestFrom?: WorkflowValueReference;
  predicate?: { field: string; source?: WorkflowValueReference };
}
export interface DefinitionShape {
  entry: string;
  steps: readonly StepShape[];
  allowedDelegateAgentIds: readonly string[];
  budget: {
    maxSteps: number;
    maxDelegations: number;
    maxDurationSeconds: number;
    maxDepth: number;
  };
}
export interface WorkflowProblem {
  stepId: string | null;
  code:
    | 'duplicate_step'
    | 'missing_step'
    | 'cycle'
    | 'unreachable_step'
    | 'delegate_target'
    | 'delegate_not_allowed'
    | 'budget'
    | 'binding_not_available'
    | 'invalid_reference';
}
export function workflowProblems(definition: DefinitionShape): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const byId = new Map<string, StepShape>();
  for (const step of definition.steps) {
    if (byId.has(step.id)) problems.push({ stepId: step.id, code: 'duplicate_step' });
    byId.set(step.id, step);
    if (step.type === 'delegate') {
      if (Boolean(step.agentId) === Boolean(step.connectionId))
        problems.push({ stepId: step.id, code: 'delegate_target' });
      if (step.agentId && !definition.allowedDelegateAgentIds.includes(step.agentId))
        problems.push({ stepId: step.id, code: 'delegate_not_allowed' });
    }
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) {
      problems.push({ stepId: id, code: 'cycle' });
      return;
    }
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) {
      problems.push({ stepId: id, code: 'missing_step' });
      return;
    }
    visited.add(id);
    active.add(id);
    const refs =
      step.type === 'condition' || step.type === 'branch'
        ? [step.then, step.otherwise]
        : [step.next];
    for (const ref of refs) if (ref) visit(ref);
    active.delete(id);
  };
  visit(definition.entry);
  for (const step of definition.steps)
    if (!visited.has(step.id)) problems.push({ stepId: step.id, code: 'unreachable_step' });
  // Bindings may only reference steps that run on every path into this node.
  const predecessors = new Map<string, string[]>();
  for (const step of definition.steps) {
    for (const target of step.type === 'condition' || step.type === 'branch'
      ? [step.then, step.otherwise]
      : [step.next]) {
      if (target) predecessors.set(target, [...(predecessors.get(target) ?? []), step.id]);
    }
  }
  const dom = new Map<string, Set<string>>();
  const dominators = (id: string, seen = new Set<string>()): Set<string> => {
    const cached = dom.get(id);
    if (cached) return cached;
    if (seen.has(id)) return new Set();
    const nextSeen = new Set(seen).add(id);
    const parents = predecessors.get(id) ?? [];
    const sets =
      id === definition.entry ? [] : parents.map((parent) => dominators(parent, nextSeen));
    const common = new Set(sets[0] ?? []);
    for (const set of sets.slice(1)) {
      for (const member of common) if (!set.has(member)) common.delete(member);
    }
    common.add(id);
    dom.set(id, common);
    return common;
  };
  for (const step of definition.steps) {
    const refs = [
      ...Object.values(step.bindings ?? {}),
      step.queryFrom,
      step.requestFrom,
      step.predicate?.source,
    ].filter((ref): ref is WorkflowValueReference => !!ref);
    if (step.predicate?.field === 'result' && !step.predicate.source)
      problems.push({ stepId: step.id, code: 'invalid_reference' });
    for (const ref of refs) {
      if (ref.stepId === step.id || !dominators(step.id).has(ref.stepId))
        problems.push({ stepId: step.id, code: 'binding_not_available' });
      if (ref.path.some((part) => typeof part === 'string' && FORBIDDEN_PATH_KEYS.has(part)))
        problems.push({ stepId: step.id, code: 'invalid_reference' });
    }
    if (Object.keys(step.bindings ?? {}).some((key) => FORBIDDEN_PATH_KEYS.has(key)))
      problems.push({ stepId: step.id, code: 'invalid_reference' });
  }
  if (
    definition.budget.maxSteps < definition.steps.length ||
    definition.budget.maxDelegations <
      definition.steps.filter((s) => s.type === 'delegate').length ||
    (definition.steps.some((s) => s.type === 'delegate') && definition.budget.maxDepth < 1)
  )
    problems.push({ stepId: null, code: 'budget' });
  return problems;
}
export function matchesPredicate(
  predicate: Predicate,
  facts: Readonly<Record<string, unknown>>,
): boolean {
  const value = facts[predicate.field];
  // Unknown facts never satisfy a negative predicate either.
  if (value === undefined || value === null) return false;
  if (predicate.op === 'contains') return Array.isArray(value) && value.includes(predicate.value);
  const same = value === predicate.value;
  return predicate.op === 'is' ? same : !same;
}
export const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'cancelled', 'handed_off', 'failed']);
export function workflowFence(input: {
  state: string;
  epoch: number;
  currentEpoch: number;
  ownerMode: string;
  cancelRequested: boolean;
  deadline: Date;
  now: Date;
}): string | null {
  if (TERMINAL_WORKFLOW_STATES.has(input.state)) return 'terminal';
  if (input.cancelRequested) return 'cancel_requested';
  if (input.ownerMode !== 'AI_ACTIVE' || input.currentEpoch !== input.epoch) return 'owner_changed';
  if (input.now >= input.deadline) return 'duration_budget';
  return null;
}
/** A crashed advisory delegation is ambiguous; never issue its remote request again automatically. */
export function recoveryDisposition(type: string, state: string): 'resume' | 'unknown' {
  return state === 'running' && type === 'delegate' ? 'unknown' : 'resume';
}

const FORBIDDEN_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export class WorkflowBindingError extends Error {
  constructor() {
    super('A configured workflow result is unavailable or invalid.');
    this.name = 'WorkflowBindingError';
  }
}
export function resolveWorkflowReference(
  reference: WorkflowValueReference,
  outputs: Readonly<Record<string, unknown>>,
): unknown {
  if (!Object.hasOwn(outputs, reference.stepId) || reference.path.length > 6)
    throw new WorkflowBindingError();
  let value = outputs[reference.stepId];
  for (const part of reference.path) {
    if (typeof part === 'string' && FORBIDDEN_PATH_KEYS.has(part)) throw new WorkflowBindingError();
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part))
      throw new WorkflowBindingError();
    value = (value as Record<string | number, unknown>)[part];
  }
  if (value === undefined || JSON.stringify(value).length > 16384) throw new WorkflowBindingError();
  return value;
}
export function applyWorkflowBindings(
  arguments_: Readonly<Record<string, unknown>>,
  bindings: Readonly<Record<string, WorkflowValueReference>>,
  outputs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const bound: Record<string, unknown> = { ...arguments_ };
  for (const [key, reference] of Object.entries(bindings)) {
    if (FORBIDDEN_PATH_KEYS.has(key)) throw new WorkflowBindingError();
    bound[key] = resolveWorkflowReference(reference, outputs);
  }
  if (JSON.stringify(bound).length > 16384) throw new WorkflowBindingError();
  return bound;
}
