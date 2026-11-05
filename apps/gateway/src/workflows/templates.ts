// biome-ignore-all lint/suspicious/noThenProperty: Workflow branch targets are strings, never promise callbacks.
import type { WorkflowDefinition } from '@hamnivo/contracts';

/** Data-only starting points. Tool arguments and grants still pass through normal publishing
 * validation and ToolGateway. Installing a template does not publish it or change permissions. */
export function workflowTemplates(input: {
  agentId: string;
  billingToolId: string;
  billingArguments: Record<string, string>;
  specialistAgentId: string;
}): { key: string; name: string; definition: WorkflowDefinition }[] {
  const base = {
    agentId: input.agentId,
    allowedDelegateAgentIds: [] as string[],
    trigger: { type: 'chat_started' as const },
    entry: 'start',
    budget: { maxSteps: 20, maxDelegations: 0, maxDurationSeconds: 7200, maxDepth: 0 },
  };
  return [
    {
      key: 'support',
      name: 'Support question',
      definition: {
        ...base,
        steps: [
          {
            id: 'start',
            label: 'Find the public support policy',
            type: 'knowledge_lookup',
            query: 'Support policy and escalation guidance',
            next: 'review',
          },
          {
            id: 'review',
            label: 'Ask the support team to help',
            type: 'handoff',
            reason: 'Support policy checked; a person should review the request.',
          },
        ],
      },
    },
    {
      key: 'billing',
      name: 'Billing approval',
      definition: {
        ...base,
        steps: [
          {
            id: 'start',
            label: 'Request approval for the billing action',
            type: 'approval',
            toolId: input.billingToolId,
            arguments: input.billingArguments,
            next: null,
          },
        ],
      },
    },
    {
      key: 'after_hours',
      name: 'After hours',
      definition: {
        ...base,
        steps: [
          {
            id: 'start',
            label: 'Check business hours',
            type: 'branch',
            predicate: { field: 'hours_open', op: 'is', value: false },
            then: 'wait',
            otherwise: 'team',
          },
          {
            id: 'wait',
            label: 'Wait before handing over',
            type: 'wait',
            seconds: 300,
            next: 'team',
          },
          {
            id: 'team',
            label: 'Queue for the team',
            type: 'handoff',
            reason: 'The team should follow up on this conversation.',
          },
        ],
      },
    },
    {
      key: 'sales',
      name: 'Sales specialist',
      definition: {
        ...base,
        allowedDelegateAgentIds: [input.specialistAgentId],
        budget: { ...base.budget, maxDelegations: 1, maxDepth: 1 },
        steps: [
          {
            id: 'start',
            label: 'Ask the sales specialist privately',
            type: 'delegate',
            agentId: input.specialistAgentId,
            request:
              'Summarize public sales qualification guidance for the coordinator. Do not contact the customer.',
            next: 'team',
          },
          {
            id: 'team',
            label: 'Send to the sales team',
            type: 'handoff',
            reason: 'A sales specialist prepared private advice; the sales team should review it.',
          },
        ],
      },
    },
  ];
}
