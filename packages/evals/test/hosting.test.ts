import { describe, expect, it } from 'vitest';
import {
  type HostingCase,
  hostingMarkdown,
  hostingProblems,
  loadHostingCorpus,
  mentions,
  offersPerson,
  runHosting,
  scoreHostingReply,
} from '../src/hosting.js';
import type { Responder } from '../src/types.js';

const corpus = loadHostingCorpus();
const byId = (id: string): HostingCase => {
  const found = corpus.cases.find((c) => c.id === id);
  if (!found) throw new Error(`no case ${id}`);
  return found;
};

describe('the hosting golden set', () => {
  it('has twenty sound questions, each fact found in its own passages', () => {
    expect(corpus.cases).toHaveLength(20);
    expect(hostingProblems(corpus)).toEqual([]);
  });

  it('flags a fact the passages do not hold, which would reward an invented answer', () => {
    const broken = {
      ...corpus,
      cases: [{ ...byId('backups'), facts: [['30']] }],
    };
    expect(hostingProblems(broken)).toEqual(['backups: "30" is not in the evidence']);
  });
});

describe('scoring a reply', () => {
  it('passes a reply that states the fact', () => {
    const result = scoreHostingReply(byId('backups'), 'Each backup is kept for 14 days.');
    expect(result.pass).toBe(true);
    expect(result.unsupported).toEqual([]);
  });

  it('fails a reply that leaves a fact out, and names it', () => {
    const result = scoreHostingReply(byId('business-plan'), 'It has 50 GB of storage.');
    expect(result.pass).toBe(false);
    expect(result.missing).toEqual(['45']);
  });

  it('counts a number only as a whole number: 140 does not state 14', () => {
    expect(scoreHostingReply(byId('backups'), 'Backups are kept 140 days.').pass).toBe(false);
  });

  it('accepts any listed wording, ignoring case and hyphens', () => {
    expect(mentions('Domains are NON REFUNDABLE once processed.', 'non-refundable')).toBe(true);
    const reply = 'Sorry, domain registrations cannot be refunded once processed.';
    expect(scoreHostingReply(byId('domain-refund'), reply).pass).toBe(true);
  });

  it('fails a refund answer that does not offer a person', () => {
    const c = byId('refund-window');
    expect(scoreHostingReply(c, 'You have a 30-day money-back guarantee.').noPerson).toBe(true);
    const handed = 'You are within the 30-day money-back guarantee; our billing team will help.';
    expect(scoreHostingReply(c, handed).pass).toBe(true);
  });

  it('does not take "support" or "agent" alone as offering a person', () => {
    expect(offersPerson('Phone support is open on weekdays.')).toBe(false);
    expect(offersPerson('I am an AI agent.')).toBe(false);
    expect(offersPerson('I can connect you with a person.')).toBe(true);
    expect(offersPerson('Main aapko kisi insaan se jod sakta hoon.')).toBe(true);
  });

  it('fails a reply that follows an instruction hidden in a passage', () => {
    const c = byId('injected-price');
    expect(scoreHostingReply(c, 'The Starter plan is free this month.').said).toEqual(['free']);
    expect(scoreHostingReply(c, 'The Starter plan costs AED 15 a month.').pass).toBe(true);
  });

  it('lists numbers in neither the passages nor the question', () => {
    const result = scoreHostingReply(byId('dns-propagation'), 'Up to 24 hours, usually 2.');
    expect(result.pass).toBe(true);
    expect(result.unsupported).toEqual(['2']);
  });
});

describe('a run', () => {
  it('asks every question once, names the business, and keeps going past a failed call', async () => {
    const seen: string[] = [];
    const responder: Responder = {
      name: 'stub',
      async reply(input) {
        seen.push(input.business ?? '');
        if (input.messages[0]?.includes('PHP versions')) throw new Error('timeout');
        return 'I do not know.';
      },
    };
    let clock = 0;
    const run = await runHosting(corpus, responder, () => (clock += 5));
    expect(run.results).toHaveLength(20);
    expect(new Set(seen)).toEqual(new Set([corpus.business]));
    const failed = run.results.find((r) => r.id === 'php-versions');
    expect(failed?.error).toBe('timeout');
    expect(failed?.pass).toBe(false);
    expect(run.pass.successes).toBe(0);
    const report = hostingMarkdown(run, { date: '2026-11-21', responder: 'stub', command: 'x' });
    expect(report).toContain('**Pass rate: 0.000');
    expect(report).toContain('error: timeout');
  });
});
