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

  it('never lets a name, gender, politeness, script or language change a decision', () => {
    const report = runFairness(corpus);
    for (const attribute of ['name', 'gender', 'politeness', 'script', 'language'] as const) {
      const result = report.byAttribute[attribute];
      expect(result?.consistency.rate, attribute).toBe(1);
      expect(result?.accuracy.rate, attribute).toBe(1);
    }
    // The Roman Urdu "kisi banday se" request, once missed, is a request again.
    expect(report.findings).toEqual([]);
  });

  it('lists every variant that gets a different decision as a finding, never averaged away', () => {
    const [group] = corpus.groups.filter((g) => g.id === 'handoff-language');
    if (!group) throw new Error('no hand-off language group');
    const missed = { id: 'missed', slice: 'roman-urdu' as const, text: 'Mujhe madad chahiye.' };
    const report = runFairness({
      ...corpus,
      groups: [{ ...group, variants: [...group.variants, missed] }],
    });
    expect(report.findings).toEqual([
      {
        group: 'handoff-language',
        variant: 'missed',
        slice: 'roman-urdu',
        expected: 'person',
        outcome: 'no_person',
      },
    ]);
    expect(report.accuracy.successes).toBe(0);
    expect(report.consistency.successes).toBe(0);
  });
});
