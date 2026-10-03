import { describe, expect, it } from 'vitest';
import { decideExecution, type ExecutionInput } from '../../src/actions/index.js';

const base = (overrides: Partial<ExecutionInput> = {}): ExecutionInput => ({
  risk: 'read',
  approver: 'customer',
  status: 'enabled',
  stopped: false,
  autopilot: { tool: true, grant: true, tenant: true },
  run: { used: 0, max: 4 },
  conversation: { used: 0, max: 5 },
  tenant: { used: 0, max: 100 },
  untrustedContext: false,
  customerPresent: true,
  ...overrides,
});

describe('decideExecution', () => {
  it('runs allowlisted reads and low-risk writes on autopilot within budgets', () => {
    expect(decideExecution(base())).toEqual({ kind: 'execute' });
    expect(decideExecution(base({ risk: 'write' }))).toEqual({ kind: 'execute' });
  });

  it('never runs money or irreversible actions on autopilot', () => {
    expect(decideExecution(base({ risk: 'money', approver: 'staff' }))).toEqual({
      kind: 'approval',
      approver: 'staff',
      reason: 'policy',
    });
    expect(decideExecution(base({ risk: 'irreversible', approver: 'staff' }))).toMatchObject({
      kind: 'approval',
    });
  });

  it.each([
    [{ tool: false, grant: true, tenant: true }],
    [{ tool: true, grant: false, tenant: true }],
    [{ tool: true, grant: true, tenant: false }],
  ])('needs approval when any autopilot switch is off: %j', (autopilot) => {
    expect(decideExecution(base({ risk: 'write', autopilot }))).toEqual({
      kind: 'approval',
      approver: 'customer',
      reason: 'policy',
    });
  });

  it('refuses disabled, unreviewed and stopped tools, and calls beyond the run limit', () => {
    expect(decideExecution(base({ status: 'disabled' }))).toEqual({
      kind: 'deny',
      reason: 'tool_disabled',
    });
    expect(decideExecution(base({ status: 'review' }))).toEqual({
      kind: 'deny',
      reason: 'tool_in_review',
    });
    expect(decideExecution(base({ stopped: true }))).toEqual({
      kind: 'deny',
      reason: 'tool_stopped',
    });
    expect(decideExecution(base({ run: { used: 4, max: 4 } }))).toEqual({
      kind: 'deny',
      reason: 'run_limit',
    });
    expect(decideExecution(base({ run: { used: 3, max: 4 } }))).toEqual({ kind: 'execute' });
  });

  it('asks for approval for a change beyond the conversation or tenant budget', () => {
    expect(decideExecution(base({ risk: 'write', conversation: { used: 5, max: 5 } }))).toEqual({
      kind: 'approval',
      approver: 'customer',
      reason: 'budget',
    });
    expect(decideExecution(base({ risk: 'write', tenant: { used: 100, max: 100 } }))).toMatchObject(
      {
        reason: 'budget',
      },
    );
    expect(decideExecution(base({ tenant: { used: 100, max: 100 } }))).toEqual({
      kind: 'deny',
      reason: 'budget_exhausted',
    });
    expect(decideExecution(base({ risk: 'write', tenant: { used: 99, max: 100 } }))).toEqual({
      kind: 'execute',
    });
  });

  it('asks a person before a change proposed after reading untrusted tool output', () => {
    expect(decideExecution(base({ risk: 'write', untrustedContext: true }))).toEqual({
      kind: 'approval',
      approver: 'customer',
      reason: 'untrusted_context',
    });
    // A lookup is not a change: it still runs.
    expect(decideExecution(base({ untrustedContext: true }))).toEqual({ kind: 'execute' });
  });

  it('refuses a customer approval when there is no customer to ask', () => {
    expect(
      decideExecution(
        base({
          risk: 'write',
          autopilot: { tool: false, grant: true, tenant: true },
          customerPresent: false,
        }),
      ),
    ).toEqual({ kind: 'deny', reason: 'no_approver' });
  });
});
