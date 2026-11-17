import { describe, expect, it } from 'vitest';
import type { Passage } from '../src/knowledge/retrieval.service.js';
import { actionRules, assistantTools, newEffects } from '../src/runtime/assistant-actions.js';

const passage = (chunkId: string, text: string): Passage => ({
  chunkId,
  documentId: `doc-${chunkId}`,
  sourceId: 'src',
  versionId: 'v1',
  version: 1,
  title: 'Shipping',
  url: null,
  heading: null,
  text,
  score: 1,
});

const all = { handoff: true, choices: true, contact: true, search: true };
const run = (tool: unknown, input: unknown) =>
  (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 't',
    messages: [],
  });

describe('the assistant’s own actions', () => {
  it('offers only the actions that are on, and tells the model about those only', () => {
    const effects = newEffects();
    const some = assistantTools(
      { ...all, contact: false, search: false },
      effects,
      [],
      async () => [],
    );
    expect(Object.keys(some).sort()).toEqual(['handoff_to_person', 'offer_choices']);
    expect(actionRules({ ...all, contact: false, search: false })).toContain('handoff_to_person');
    expect(actionRules({ ...all, contact: false, search: false })).not.toContain('save_contact');
    expect(actionRules({ handoff: false, choices: false, contact: false, search: false })).toBe('');
  });

  it('searches again in its own words, numbering what it finds after the passages it has', async () => {
    const effects = newEffects();
    const passages = [passage('a', 'We ship in two days.')];
    const tools = assistantTools(all, effects, passages, async () => [
      passage('a', 'We ship in two days.'),
      passage('b', 'Lahore and Karachi get next-day delivery.'),
    ]);
    const found = (await run(tools.search_knowledge, { query: 'next day Lahore' })) as {
      passages: Array<{ cite: string; text: string }>;
    };
    // Already known passages are not repeated; the new one is cited as [2].
    expect(found.passages).toEqual([
      { cite: '[2]', title: 'Shipping', text: 'Lahore and Karachi get next-day delivery.' },
    ]);
    expect(passages.map((p) => p.chunkId)).toEqual(['a', 'b']);
    await run(tools.search_knowledge, { query: 'more' });
    const third = (await run(tools.search_knowledge, { query: 'again' })) as { note: string };
    expect(third.note).toBe('No more searches.');
  });

  it('keeps only usable contact details, and at least two choices', async () => {
    const effects = newEffects();
    const tools = assistantTools(all, effects, [], async () => []);
    await run(tools.save_contact, { name: ' Sara ', email: 'SARA@Example.com', phone: 'call me' });
    expect(effects.contact).toEqual({ name: 'Sara', email: 'sara@example.com' });
    const one = (await run(tools.offer_choices, { prompt: 'Pick', options: ['Yes', 'Yes'] })) as {
      ok: boolean;
    };
    expect(one.ok).toBe(false);
    expect(effects.choices).toBeNull();
  });
});
