import { describe, expect, it } from 'vitest';
import { showPersonButton } from '../src/availability.js';

/**
 * The standing "Talk to a person" button follows the brand's choice (W11): never, always, or once
 * the AI has answered a few times, so customers try the AI first. Asking in words always works.
 */

const ai = { sender: { kind: 'ai_agent' } };
const customer = { sender: { kind: 'customer' } };
const person = { sender: { kind: 'human_agent' } };

describe('the "Talk to a person" button', () => {
  it('after the AI has tried: only once the AI has answered three times', () => {
    const handoff = { personButton: 'after_ai', afterAnswers: 3 } as const;
    expect(showPersonButton(handoff, [])).toBe(false);
    expect(showPersonButton(handoff, [customer, ai, customer, ai])).toBe(false);
    // Customer messages and a teammate's do not count as AI answers.
    expect(showPersonButton(handoff, [customer, ai, customer, ai, person, customer])).toBe(false);
    expect(showPersonButton(handoff, [customer, ai, customer, ai, customer, ai])).toBe(true);
  });

  it('never and always mean what they say', () => {
    expect(showPersonButton({ personButton: 'never', afterAnswers: 3 }, [ai, ai, ai, ai])).toBe(
      false,
    );
    expect(showPersonButton({ personButton: 'always', afterAnswers: 3 }, [])).toBe(true);
  });

  it('shows as before when the gateway predates the choice', () => {
    expect(showPersonButton(undefined, [])).toBe(true);
  });
});
