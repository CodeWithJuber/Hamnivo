import { readFileSync } from 'node:fs';
import type { AdjudicationCorpus, FairnessCorpus, SycophancyCorpus } from './types.js';
import { PRESSURE_KINDS } from './types.js';

const SLICES = ['en', 'ar', 'hi', 'ur', 'hinglish', 'roman-urdu'] as const;

function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../corpus/${name}.json`, import.meta.url), 'utf8')) as T;
}

/** Problems that would make a corpus measure the wrong thing; empty when it is sound. */
export function sycophancyProblems(corpus: SycophancyCorpus): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const s of corpus.scenarios) {
    if (ids.has(s.id)) problems.push(`${s.id}: duplicate id`);
    ids.add(s.id);
    if (!SLICES.includes(s.slice)) problems.push(`${s.id}: unknown slice ${s.slice}`);
    if (s.truth.length === 0 || s.claim.length === 0)
      problems.push(`${s.id}: needs truth and claim`);
    if (s.truth.some((value) => s.claim.includes(value)))
      problems.push(`${s.id}: truth and claim overlap`);
    for (const kind of PRESSURE_KINDS) {
      if (!s.pressure[kind]?.trim()) problems.push(`${s.id}: missing ${kind}`);
    }
  }
  return problems;
}

export function fairnessProblems(corpus: FairnessCorpus): string[] {
  const problems: string[] = [];
  for (const g of corpus.groups) {
    if (g.variants.length < 2) problems.push(`${g.id}: a pair needs at least two variants`);
    const texts = new Set(g.variants.map((v) => v.text));
    if (texts.size < g.variants.length && g.attribute !== 'language') {
      problems.push(`${g.id}: variants must differ`);
    }
  }
  return problems;
}

export function adjudicationProblems(corpus: AdjudicationCorpus): string[] {
  const problems: string[] = [];
  for (const s of corpus.scenarios) {
    for (const slice of SLICES) {
      if (!s.messages[slice]?.trim()) problems.push(`${s.id}: missing ${slice}`);
    }
    if (!s.offersPerson && s.facts.length === 0) problems.push(`${s.id}: needs facts`);
  }
  return problems;
}

export const loadSycophancyCorpus = () => read<SycophancyCorpus>('sycophancy');
export const loadFairnessCorpus = () => read<FairnessCorpus>('fairness');
export const loadAdjudicationCorpus = () => read<AdjudicationCorpus>('adjudication');
