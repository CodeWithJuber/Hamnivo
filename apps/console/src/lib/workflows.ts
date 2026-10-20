import type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowStep } from '@hamnivo/contracts';
import { api } from './api';
import { useStudioMutation, useStudioQuery } from './queries';

export type { Workflow, WorkflowDefinition, WorkflowRun, WorkflowStep };
export const workflowKey = (brandId: string) => ['workflows', brandId];
export function useWorkflows(brandId: string, enabled: boolean) {
  return useStudioQuery<{ items: Workflow[] }>(
    workflowKey(brandId),
    `/v1/admin/brands/${brandId}/workflows`,
    { enabled: enabled && !!brandId },
  );
}
export function useWorkflowChange(brandId: string) {
  return useStudioMutation(
    (v: { path: string; method?: 'PUT' | 'POST'; body?: unknown }, tenant) =>
      api<Workflow>(v.path, { tenant, method: v.method ?? 'POST', body: v.body }),
    [workflowKey(brandId), ['workflow-versions'], ['workflow-runs']],
  );
}
export function newWorkflowStep(
  type: WorkflowStep['type'],
  id: string,
  label: string,
): WorkflowStep {
  const base = { id, label };
  switch (type) {
    case 'handoff':
      return { ...base, type, reason: label };
    case 'condition':
    case 'branch':
      return {
        ...base,
        type,
        predicate: { field: 'signed_in', op: 'is', value: true },
        // biome-ignore lint/suspicious/noThenProperty: branch target is a required workflow contract field
        then: null,
        otherwise: null,
      };
    case 'knowledge_lookup':
      return { ...base, type, query: label, next: null };
    case 'wait':
      return { ...base, type, seconds: 60, next: null };
    case 'tool_action':
    case 'approval':
      return { ...base, type, toolId: '', arguments: {}, next: null };
    case 'delegate':
      return { ...base, type, request: label, next: null };
    default:
      return { ...base, type: 'trigger', next: null };
  }
}
export function removeWorkflowStep(definition: WorkflowDefinition, id: string): WorkflowDefinition {
  const steps = definition.steps
    .filter((step) => step.id !== id)
    .map((step) =>
      'next' in step
        ? { ...step, next: step.next === id ? null : step.next }
        : 'then' in step
          ? {
              ...step,
              // biome-ignore lint/suspicious/noThenProperty: branch target is a required workflow contract field
              then: step.then === id ? null : step.then,
              otherwise: step.otherwise === id ? null : step.otherwise,
            }
          : step,
    );
  return {
    ...definition,
    steps,
    entry: definition.entry === id ? (steps[0]?.id ?? 'start') : definition.entry,
  };
}

export type WorkflowTemplate =
  | 'support'
  | 'lead'
  | 'billing'
  | 'service'
  | 'afterhours'
  | 'handoff';
/** Templates contain no implicit tool grant, credential or arbitrary external endpoint. */
export function workflowTemplate(
  template: WorkflowTemplate,
  agentId: string,
  label: string,
): WorkflowDefinition {
  const end: WorkflowStep = { id: 'handoff', type: 'handoff', label, reason: label };
  const steps: WorkflowStep[] =
    template === 'handoff'
      ? [end]
      : template === 'afterhours'
        ? [
            {
              id: 'hours',
              label,
              type: 'condition',
              predicate: { field: 'hours_open', op: 'is', value: true },
              // biome-ignore lint/suspicious/noThenProperty: branch target is a required workflow contract field
              then: 'handoff',
              otherwise: 'knowledge',
            },
            { id: 'knowledge', type: 'knowledge_lookup', label, query: label, next: 'handoff' },
            end,
          ]
        : [
            { id: 'knowledge', type: 'knowledge_lookup', label, query: label, next: 'handoff' },
            end,
          ];
  return {
    agentId,
    allowedDelegateAgentIds: [],
    entry: steps[0]?.id ?? 'handoff',
    trigger: { type: 'manual' },
    steps,
    budget: { maxSteps: 20, maxDelegations: 0, maxDurationSeconds: 3600, maxDepth: 0 },
  };
}
