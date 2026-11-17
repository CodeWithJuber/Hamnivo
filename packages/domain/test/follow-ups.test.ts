import { describe, expect, it } from 'vitest';
import { FOLLOW_UP_MAX_LENGTH, followUpsOf, mockFollowUps } from '../src/follow-ups.js';

describe('questions offered after an answer', () => {
  it('keeps at most three short questions, without numbering, bullets or quotes', () => {
    expect(
      followUpsOf(
        '1. When will it arrive?\n- "Can I change the address?"\n• Do you ship abroad?\n4) What about returns?',
      ),
    ).toEqual(['When will it arrive?', 'Can I change the address?', 'Do you ship abroad?']);
  });

  it('drops links, markup, repeats, empty and overlong lines', () => {
    const long = `Why ${'really '.repeat(30)}?`;
    expect(long.length).toBeGreaterThan(FOLLOW_UP_MAX_LENGTH);
    expect(
      followUpsOf(
        `\n\nWhere is my order?\nwhere is my order?\nSee https://evil.example\nMail me@x.io\n<b>Hi</b>\n${long}\nOk`,
      ),
    ).toEqual(['Where is my order?']);
    expect(followUpsOf('')).toEqual([]);
  });

  it('offers only questions, never the customer’s question or the answer said back', () => {
    const question = 'Where is my order?';
    const answer = 'Your order ships today. It arrives on Thursday.';
    expect(
      followUpsOf(
        [
          'Customer: Where is my order?',
          'Answer: Your order ships today.',
          'It arrives on Thursday.',
          'where is my order',
          'Q: Can I change the delivery address?',
          'Do you ship to Lahore؟',
          'Thank you',
        ].join('\n'),
        [question, answer],
      ),
    ).toEqual(['Can I change the delivery address?', 'Do you ship to Lahore؟']);
  });

  it('answers in the script of the answer for tests and the mock provider', () => {
    expect(followUpsOf(mockFollowUps('Your order ships today.'))).toHaveLength(2);
    expect(mockFollowUps('طلبك في الطريق')).toMatch(/[؀-ۿ]/);
    expect(mockFollowUps('आपका ऑर्डर आ गया')).toMatch(/[ऀ-ॿ]/);
  });
});
