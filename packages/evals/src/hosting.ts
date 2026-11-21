/**
 * The hosting golden set: questions a web host's customers ask (billing, refunds, DNS, SSL,
 * plans, email, domains), each with the passages the assistant is given and what a right reply
 * says. Replies are scored without a person:
 *
 * - every expected fact is stated (each fact lists the wordings that count);
 * - a person is offered where the right answer is a person (refunds, out-of-scope work);
 * - nothing forbidden is said (an instruction hidden in a passage is not followed).
 *
 * Numbers in a reply that are in neither the passages nor the question are listed apart, for a
 * person to judge: they are often an invented fact, sometimes a harmless "24/7".
 */
import { readFileSync } from 'node:fs';
import type { ReplyLanguage } from '@hamnivo/domain';
import { formatRate, type Rate, wilson } from './stats.js';
import { normalizeDigits, numbersIn, statesValue } from './text.js';
import type { Responder } from './types.js';

export interface HostingCase {
  id: string;
  topic: string;
  language: ReplyLanguage;
  /** The knowledge passages the assistant is given. */
  evidence: string[];
  question: string;
  /** Each fact a right reply states, as the wordings that count for it. */
  facts: string[][];
  /** The right reply offers a person (the assistant cannot do it, or must not). */
  offersPerson: boolean;
  /** Words a right reply never says. */
  forbidden?: string[];
}

export interface HostingCorpus {
  version: number;
  /** Who the assistant works for, as the prompt names it. */
  business: string;
  cases: HostingCase[];
}

export const loadHostingCorpus = (): HostingCorpus =>
  JSON.parse(
    readFileSync(new URL('../corpus/hosting.json', import.meta.url), 'utf8'),
  ) as HostingCorpus;

/** Problems that would make the golden set measure the wrong thing; empty when it is sound. */
export function hostingProblems(corpus: HostingCorpus): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const c of corpus.cases) {
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    if (!c.question.trim()) problems.push(`${c.id}: needs a question`);
    if (c.evidence.length === 0) problems.push(`${c.id}: needs evidence`);
    if (c.facts.length === 0 && !c.offersPerson) problems.push(`${c.id}: needs facts`);
    const evidence = c.evidence.join('\n');
    // A fact the passages do not hold would reward a model for inventing it.
    for (const fact of c.facts) {
      if (fact.length === 0) problems.push(`${c.id}: an empty fact`);
      else if (!fact.some((wording) => mentions(evidence, wording)))
        problems.push(`${c.id}: "${fact.join('" or "')}" is not in the evidence`);
    }
  }
  return problems;
}

/** Whether `text` says `wording`: a number as a whole number, words ignoring case and spacing. */
export function mentions(text: string, wording: string): boolean {
  if (/^\d+(\.\d+)?$/.test(wording)) return statesValue(text, wording);
  const squash = (value: string) =>
    normalizeDigits(value)
      .toLowerCase()
      .replace(/[’']/g, "'")
      .replace(/[\s-]+/g, ' ');
  return squash(text).includes(squash(wording));
}

/**
 * Words that offer a person, in the reply languages this set uses. "Support" and "agent" alone do
 * not count: "phone support is open" offers no one, and the assistant is an agent itself.
 */
const PERSON = [
  /\b(person|human|someone|somebody|colleague|team|teammate|staff|representative|specialist)\b/i,
  /\b(insaan|vyakti|banda|bande)\b/i,
];

export function offersPerson(reply: string): boolean {
  return PERSON.some((pattern) => pattern.test(reply));
}

export interface HostingResult {
  id: string;
  topic: string;
  language: ReplyLanguage;
  question: string;
  reply: string;
  /** Facts not stated, by their first wording. */
  missing: string[];
  /** A person was due and not offered. */
  noPerson: boolean;
  /** Forbidden words the reply says. */
  said: string[];
  /** Numbers in the reply found in neither the passages nor the question. */
  unsupported: string[];
  ms: number;
  error?: string;
  pass: boolean;
}

export function scoreHostingReply(c: HostingCase, reply: string): Omit<HostingResult, 'ms'> {
  const missing = c.facts
    .filter((fact) => !fact.some((wording) => mentions(reply, wording)))
    .map((fact) => fact[0] ?? '');
  const noPerson = c.offersPerson && !offersPerson(reply);
  const said = (c.forbidden ?? []).filter((word) => mentions(reply, word));
  const known = new Set(numbersIn([...c.evidence, c.question].join('\n')));
  const unsupported = [...new Set(numbersIn(reply))].filter((n) => !known.has(n));
  return {
    id: c.id,
    topic: c.topic,
    language: c.language,
    question: c.question,
    reply,
    missing,
    noPerson,
    said,
    unsupported,
    pass: missing.length === 0 && !noPerson && said.length === 0,
  };
}

export interface HostingRun {
  results: HostingResult[];
  pass: Rate;
  /** Replies with a number the passages and the question do not hold. */
  unsupported: Rate;
}

/** Asks every question once, one at a time, and scores the replies. */
export async function runHosting(
  corpus: HostingCorpus,
  responder: Responder,
  now: () => number = Date.now,
): Promise<HostingRun> {
  const results: HostingResult[] = [];
  for (const c of corpus.cases) {
    const started = now();
    try {
      const reply = await responder.reply({
        evidence: c.evidence,
        messages: [c.question],
        language: c.language,
        business: corpus.business,
      });
      results.push({ ...scoreHostingReply(c, reply), ms: now() - started });
    } catch (error) {
      results.push({
        ...scoreHostingReply(c, ''),
        ms: now() - started,
        error: error instanceof Error ? error.message : String(error),
        pass: false,
      });
    }
  }
  return {
    results,
    pass: wilson(results.filter((r) => r.pass).length, results.length),
    unsupported: wilson(results.filter((r) => r.unsupported.length > 0).length, results.length),
  };
}

export interface HostingReportMeta {
  date: string;
  responder: string;
  command: string;
  inputTokens?: number;
  outputTokens?: number;
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function why(r: HostingResult): string {
  if (r.error) return `error: ${r.error}`;
  const reasons = [
    ...r.missing.map((fact) => `missing "${fact}"`),
    ...(r.noPerson ? ['no person offered'] : []),
    ...r.said.map((word) => `said "${word}"`),
  ];
  return reasons.join('; ') || '–';
}

/** The run as a Markdown report for docs/evals. */
export function hostingMarkdown(run: HostingRun, meta: HostingReportMeta): string {
  const times = run.results.map((r) => r.ms).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor((times.length - 1) / 2)] : null;
  const tokens =
    meta.inputTokens !== undefined
      ? `${meta.inputTokens} in, ${meta.outputTokens ?? 0} out`
      : 'not reported';
  const lines = [
    `# Hosting golden set: ${meta.responder}, ${meta.date}`,
    '',
    `- Responder: \`${meta.responder}\``,
    `- Command: \`${meta.command}\``,
    `- Questions: ${run.results.length}, one call each, one at a time`,
    `- Tokens: ${tokens}`,
    `- Median reply time: ${median === null ? '–' : `${median} ms`}`,
    '',
    '## Summary',
    '',
    `- **Pass rate: ${formatRate(run.pass)}.** A reply passes when it states every expected fact, offers a person where one is due and says nothing forbidden.`,
    `- Replies with a number in neither the passages nor the question: ${formatRate(run.unsupported)}. Read them below; some are invented facts.`,
    '- What this measures: Hamnivo reply rules plus the model, given the passages. It does not run the agent loop, tools, memory or the handoff itself.',
    '- The host and its facts are made up (`packages/evals/corpus/hosting.json`); no customer data is used.',
    '',
    '## Replies',
    '',
    '| Case | Topic | Pass | Why not | Unsupported numbers | Reply |',
    '| --- | --- | --- | --- | --- | --- |',
    ...run.results.map(
      (r) =>
        `| ${r.id} | ${r.topic} | ${r.pass ? 'yes' : '**no**'} | ${cell(why(r))} | ${r.unsupported.join(', ') || '–'} | ${cell(r.reply)} |`,
    ),
    '',
  ];
  return lines.join('\n');
}
