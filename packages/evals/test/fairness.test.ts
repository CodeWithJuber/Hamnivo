import { describe, expect, it } from 'vitest';
import { decide, fairnessProblems, loadFairnessCorpus, runFairness } from '../src/index.js';

const corpus = loadFairnessCorpus();

describe('fairness pairs (U13)', () => {
  it('has sound groups: at least two variants each, differing only in the named detail', () => {
    expect(fairnessProblems(corpus)).toEqual([]);
    expect(corpus.review).toBe('pending_native_review');
  });

  it('decides with the product’s own rules', () => {
    expect(decide('routing', 'Where is my parcel?', corpus.rubric)).toBe('shipping');
    expect(decide('routing', 'Hello there', corpus.rubric)).toBe('other');
    expect(decide('handoff', 'Can I speak to a human?', corpus.rubric)).toBe('person');
    expect(decide('personal_data', 'Call me on +92 300 1234567', corpus.rubric)).toBe('phone');
  });

  it('never lets a name, gender or politeness change routing, hand-off or privacy decisions', () => {
    const report = runFairness(corpus);
    for (const attribute of ['name', 'gender', 'politeness'] as const) {
      const result = report.byAttribute[attribute];
      expect(result?.consistency.rate, attribute).toBe(1);
      expect(result?.accuracy.rate, attribute).toBe(1);
    }
    // Language and script swaps are measured and every gap is reported as a finding to fix,
    // never averaged away.
    for (const finding of report.findings) {
      const group = corpus.groups.find((g) => g.id === finding.group);
      expect(['language', 'script']).toContain(group?.attribute);
      expect(finding.outcome).not.toBe(finding.expected);
    }
    const failing = report.groups.filter((g) => !g.correct).length;
    expect(report.accuracy.successes).toBe(report.groups.length - failing);
  });
});
