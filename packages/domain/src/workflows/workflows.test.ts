// biome-ignore-all lint/suspicious/noThenProperty: Workflow branch targets are strings, never promise callbacks.
import { describe, expect, it } from 'vitest';
import {
  applyWorkflowBindings,
  type DefinitionShape,
  matchesPredicate,
  recoveryDisposition,
  resolveWorkflowReference,
  workflowFence,
  workflowProblems,
} from './index.js';

const definition = (steps: DefinitionShape['steps']): DefinitionShape => ({
  entry: 'start',
  steps,
  allowedDelegateAgentIds: ['specialist'],
  budget: { maxSteps: 50, maxDelegations: 8, maxDurationSeconds: 300, maxDepth: 2 },
});
describe('finite workflows', () => {
  it('rejects loops, unreachable steps, missing branches and duplicate identifiers', () => {
    expect(
      workflowProblems(
        definition([
          { id: 'start', type: 'branch', then: 'start', otherwise: 'missing' },
          { id: 'other', type: 'handoff' },
          { id: 'other', type: 'handoff' },
        ]),
      ).map((p) => p.code),
    ).toEqual(
      expect.arrayContaining(['cycle', 'missing_step', 'unreachable_step', 'duplicate_step']),
    );
  });
  it('requires one explicitly permitted delegation target and a bounded parent budget', () => {
    expect(
      workflowProblems(
        definition([{ id: 'start', type: 'delegate', agentId: 'foreign', connectionId: 'remote' }]),
      ).map((p) => p.code),
    ).toEqual(expect.arrayContaining(['delegate_target', 'delegate_not_allowed']));
    const def = definition([{ id: 'start', type: 'delegate', agentId: 'specialist' }]);
    def.budget.maxDelegations = 0;
    expect(workflowProblems(def)).toContainEqual({ stepId: null, code: 'budget' });
  });
  it('unknown facts cannot satisfy negative conditions and untrusted outputs are not facts', () => {
    expect(matchesPredicate({ field: 'signed_in', op: 'is_not', value: true }, {})).toBe(false);
    expect(
      matchesPredicate({ field: 'tag', op: 'contains', value: 'billing' }, { tag: ['billing'] }),
    ).toBe(true);
  });
  it('fences canceled runs, ownership epochs, human takeover and parent deadlines', () => {
    const safe = {
      state: 'running',
      epoch: 4,
      currentEpoch: 4,
      ownerMode: 'AI_ACTIVE',
      cancelRequested: false,
      deadline: new Date(100),
      now: new Date(1),
    };
    expect(workflowFence(safe)).toBeNull();
    expect(workflowFence({ ...safe, currentEpoch: 5 })).toBe('owner_changed');
    expect(workflowFence({ ...safe, ownerMode: 'HUMAN_ACTIVE' })).toBe('owner_changed');
    expect(workflowFence({ ...safe, cancelRequested: true })).toBe('cancel_requested');
    expect(workflowFence({ ...safe, now: new Date(100) })).toBe('duration_budget');
  });
  it('resumes idempotent gateway actions after a crash but never resubmits an ambiguous delegation', () => {
    expect(recoveryDisposition('tool_action', 'running')).toBe('resume');
    expect(recoveryDisposition('delegate', 'running')).toBe('unknown');
    expect(recoveryDisposition('wait', 'waiting')).toBe('resume');
  });
  it('allows immutable result binding only from steps present on every incoming branch', () => {
    const valid = definition([
      { id: 'start', type: 'knowledge_lookup', next: 'use' },
      {
        id: 'use',
        type: 'tool_action',
        bindings: { note: { stepId: 'start', path: ['passages', 0, 'text'] } },
      },
    ]);
    expect(workflowProblems(valid)).toEqual([]);
    const unsafe = definition([
      { id: 'start', type: 'branch', then: 'left', otherwise: 'right' },
      { id: 'left', type: 'knowledge_lookup', next: 'use' },
      { id: 'right', type: 'trigger', next: 'use' },
      { id: 'use', type: 'tool_action', bindings: { note: { stepId: 'left', path: ['text'] } } },
    ]);
    expect(workflowProblems(unsafe)).toContainEqual({
      stepId: 'use',
      code: 'binding_not_available',
    });
  });
  it('binds data without evaluating expressions and rejects prototype or missing paths', () => {
    const outputs = { lookup: { text: 'Private recommendation', permissions: ['admin'] } };
    expect(
      applyWorkflowBindings(
        { orderReference: 'WF-1001' },
        { note: { stepId: 'lookup', path: ['text'] } },
        outputs,
      ),
    ).toEqual({ orderReference: 'WF-1001', note: 'Private recommendation' });
    expect(() =>
      resolveWorkflowReference({ stepId: 'lookup', path: ['constructor'] }, outputs),
    ).toThrow();
    expect(() => resolveWorkflowReference({ stepId: 'missing', path: [] }, outputs)).toThrow();
    expect(() =>
      applyWorkflowBindings({}, JSON.parse('{"__proto__":{"stepId":"lookup","path":[]}}'), outputs),
    ).toThrow();
    expect(outputs.lookup.permissions).toEqual(['admin']);
  });
});
