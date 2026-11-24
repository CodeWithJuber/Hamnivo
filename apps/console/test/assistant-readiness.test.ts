import { describe, expect, it } from 'vitest';
import {
  needsWork,
  type ReadinessFacts,
  type ReadinessStep,
  readinessSteps,
} from '../src/lib/assistant-readiness';

/**
 * Home's "Make the AI assistant work" checklist: each step's state comes from lists Studio
 * already reads, a list nobody here can read never counts as done, and the website step is
 * always for the person to check.
 */

const NOW = '2026-11-23T09:00:00.000Z';
const WHMCS_TOOL = {
  id: 'tool_whmcs',
  source: 'native',
  builtin: null,
  resourceType: 'whmcs',
  status: 'enabled',
} as const;
const DEMO_TOOL = {
  id: 'tool_demo',
  source: 'builtin',
  builtin: 'demo_issue_credit',
  resourceType: null,
  status: 'enabled',
} as const;
const BUILTINS = [
  { key: 'order_status', demo: false },
  { key: 'demo_issue_credit', demo: true },
] as const;

/** A brand where everything is in place. */
const ready: ReadinessFacts = {
  serverKey: false,
  modelConnections: [{ id: 'mcn_1', status: 'active' }],
  modelTests: [{ connectionId: 'mcn_1', ok: true, kind: 'ok', modelId: 'm', testedAt: NOW }],
  agent: { id: 'agt_1', published: true, provider: 'anthropic', grants: ['tool_whmcs'] },
  identityKeys: [{ status: 'active' }],
  connectors: [{ kind: 'whmcs', status: 'active', lastError: null }],
  tools: [WHMCS_TOOL, DEMO_TOOL],
  builtins: BUILTINS,
};

const stateOf = (facts: Partial<ReadinessFacts>, id: ReadinessStep['id']) =>
  readinessSteps({ ...ready, ...facts }).find((step) => step.id === id);

describe('the assistant checklist', () => {
  it('lists the steps in the order to do them, the website step always to check', () => {
    const steps = readinessSteps(ready);
    expect(steps.map((step) => step.id)).toEqual([
      'aikey',
      'model',
      'signin',
      'whmcs',
      'actions',
      'demo',
      'website',
    ]);
    expect(steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'check',
    ]);
    // Nothing left to do: Home shows no checklist.
    expect(needsWork(steps)).toBe(false);
  });

  it('counts an AI key only once a test passed, and says why the last test failed', () => {
    expect(stateOf({ modelConnections: [] }, 'aikey')).toEqual({ id: 'aikey', state: 'todo' });
    expect(stateOf({ modelTests: [] }, 'aikey')).toEqual({
      id: 'aikey',
      state: 'todo',
      reason: 'untested',
    });
    expect(
      stateOf(
        {
          modelTests: [
            { connectionId: 'mcn_1', ok: false, kind: 'no_credit', modelId: 'm', testedAt: NOW },
          ],
        },
        'aikey',
      ),
    ).toEqual({ id: 'aikey', state: 'attention', reason: 'no_credit' });
    // A switched-off connection does not count; the server's own key does.
    expect(
      stateOf({ modelConnections: [{ id: 'mcn_1', status: 'disabled' }] }, 'aikey')?.state,
    ).toBe('todo');
    expect(stateOf({ modelConnections: [], serverKey: true }, 'aikey')?.state).toBe('done');
  });

  it('wants a live agent on a real model', () => {
    expect(stateOf({ agent: null }, 'model')).toEqual({
      id: 'model',
      state: 'todo',
      reason: 'noAgent',
    });
    expect(stateOf({ agent: { ...needAgent(), published: false } }, 'model')).toEqual({
      id: 'model',
      state: 'todo',
      reason: 'notLive',
    });
    expect(stateOf({ agent: { ...needAgent(), provider: 'mock' } }, 'model')).toEqual({
      id: 'model',
      state: 'attention',
      reason: 'mock',
    });
  });

  it('wants an active sign-in key and a WHMCS connection whose last test passed', () => {
    expect(stateOf({ identityKeys: [{ status: 'revoked' }] }, 'signin')?.state).toBe('todo');
    expect(stateOf({ connectors: [] }, 'whmcs')?.state).toBe('todo');
    // A shop connection is not a WHMCS connection.
    expect(
      stateOf({ connectors: [{ kind: 'shopify', status: 'active', lastError: null }] }, 'whmcs')
        ?.state,
    ).toBe('todo');
    expect(
      stateOf({ connectors: [{ kind: 'whmcs', status: 'active', lastError: 'refused' }] }, 'whmcs'),
    ).toEqual({ id: 'whmcs', state: 'attention', reason: 'failing' });
    expect(
      stateOf({ connectors: [{ kind: 'whmcs', status: 'disabled', lastError: null }] }, 'whmcs'),
    ).toEqual({ id: 'whmcs', state: 'attention', reason: 'disabled' });
  });

  it('wants the agent allowed to use a WHMCS action, once WHMCS offers one', () => {
    expect(stateOf({ tools: [DEMO_TOOL] }, 'actions')).toEqual({
      id: 'actions',
      state: 'todo',
      reason: 'connectFirst',
    });
    expect(stateOf({ agent: { ...needAgent(), grants: [] } }, 'actions')?.state).toBe('todo');
    // A switched-off WHMCS action is not offered.
    expect(stateOf({ tools: [{ ...WHMCS_TOOL, status: 'disabled' }] }, 'actions')).toEqual({
      id: 'actions',
      state: 'todo',
      reason: 'connectFirst',
    });
  });

  it('flags a demo tool the agent may use, and not one it may not', () => {
    expect(
      stateOf({ agent: { ...needAgent(), grants: ['tool_whmcs', 'tool_demo'] } }, 'demo')?.state,
    ).toBe('attention');
    expect(stateOf({}, 'demo')?.state).toBe('done');
  });

  it('never counts a list it cannot read as done', () => {
    const steps = readinessSteps({
      serverKey: undefined,
      modelConnections: undefined,
      modelTests: undefined,
      agent: undefined,
      identityKeys: undefined,
      connectors: undefined,
      tools: undefined,
      builtins: undefined,
    });
    expect(steps.map((step) => step.state)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'check',
    ]);
    // Unknown is not work to do: nobody here can act on it.
    expect(needsWork(steps)).toBe(false);
  });
});

function needAgent() {
  if (!ready.agent) throw new Error('the ready brand has an agent');
  return ready.agent;
}
