import type { JsonValue } from './schema.js';

/**
 * Simulation and replay (G11, HNV-11-04/05). A suite holds canned conversations (customer
 * messages, what each tool answers, and optionally what is expected); a run replays every case
 * against the draft and the published version with the deterministic mock model and fake tools,
 * so no live action is executed and no customer data is used. Comparing the two shows what the
 * draft changes (outcomes, actions, replies) before it is published.
 */

export interface SimulationToolFake {
  /** What the tool returns; ignored when `error` is set. */
  output?: JsonValue;
  /** A tool that times out, fails, or times out after having applied the change. */
  error?: 'timeout' | 'failed' | 'timeout_after_success';
}

export const CASE_OUTCOMES = ['replied', 'handoff', 'blocked', 'error'] as const;
export type CaseOutcome = (typeof CASE_OUTCOMES)[number];

export const SIMULATED_DECISIONS = ['executed', 'approval', 'denied', 'invalid', 'failed'] as const;
export type SimulatedDecision = (typeof SIMULATED_DECISIONS)[number];

export interface SimulationCase {
  id: string;
  name: string;
  messages: string[];
  tools: Record<string, SimulationToolFake>;
  expect?: {
    outcome?: CaseOutcome;
    actions?: { tool: string; decision: SimulatedDecision }[];
  };
}

export interface SimulatedAction {
  tool: string;
  decision: SimulatedDecision;
  argumentsHash: string | null;
  /** Why it was not executed (approval reason, denial reason, validation problem). */
  reason: string | null;
}

export interface CaseResult {
  outcome: CaseOutcome;
  handoffReason: string | null;
  replies: string[];
  actions: SimulatedAction[];
}

export interface CaseComparison {
  caseId: string;
  name: string;
  candidate: CaseResult;
  baseline: CaseResult | null;
  /** What differs from the published version, in plain words. */
  changes: string[];
  /** Expectations the draft does not meet. */
  failures: string[];
}

const actionKey = (a: SimulatedAction) => `${a.tool}:${a.decision}`;

export function compareCase(
  definition: SimulationCase,
  candidate: CaseResult,
  baseline: CaseResult | null,
): CaseComparison {
  const changes: string[] = [];
  if (baseline) {
    if (baseline.outcome !== candidate.outcome) {
      changes.push(`Outcome: ${baseline.outcome} → ${candidate.outcome}`);
    }
    const before = baseline.actions.map(actionKey);
    const after = candidate.actions.map(actionKey);
    for (const action of candidate.actions) {
      if (!before.includes(actionKey(action))) {
        changes.push(`New action: ${action.tool} (${action.decision})`);
      }
    }
    for (const action of baseline.actions) {
      if (!after.includes(actionKey(action))) {
        changes.push(`No longer: ${action.tool} (${action.decision})`);
      }
    }
    if (baseline.replies.join('\n') !== candidate.replies.join('\n')) {
      changes.push('Reply text differs');
    }
  }
  const failures: string[] = [];
  const expected = definition.expect;
  if (expected?.outcome && expected.outcome !== candidate.outcome) {
    failures.push(`Expected outcome ${expected.outcome}, got ${candidate.outcome}`);
  }
  for (const wanted of expected?.actions ?? []) {
    if (!candidate.actions.some((a) => a.tool === wanted.tool && a.decision === wanted.decision)) {
      failures.push(`Expected ${wanted.tool} (${wanted.decision})`);
    }
  }
  return {
    caseId: definition.id,
    name: definition.name,
    candidate,
    baseline,
    changes,
    failures,
  };
}

export interface SimulationSummary {
  cases: number;
  changed: number;
  failed: number;
  passed: boolean;
}

export function summarizeSimulation(comparisons: CaseComparison[]): SimulationSummary {
  const failed = comparisons.filter(
    (c) => c.failures.length > 0 || c.candidate.outcome === 'error',
  );
  return {
    cases: comparisons.length,
    changed: comparisons.filter((c) => c.changes.length > 0).length,
    failed: failed.length,
    passed: failed.length === 0,
  };
}
