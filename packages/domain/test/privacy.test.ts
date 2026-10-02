import { describe, expect, it } from 'vitest';
import { findPersonalData, redactPersonalData } from '../src/index.js';

describe('findPersonalData', () => {
  it.each([
    ['Send it to ayesha@example.com please', ['email']],
    ['Call me on +92 300 1234567', ['phone']],
    ['میرا نمبر ۰۳۰۰۱۲۳۴۵۶۷ ہے', ['phone']],
    ['My card is 4242 4242 4242 4242', ['payment_card']],
    ['Where is order NL-1048?', ['reference']],
    ['Ticket #1048 is still open', ['reference']],
    ['IBAN GB82 WEST 1234 5698 7654 32', ['iban']],
    ['I live at 12 Canal Road', ['address']],
    ['Deliver to house 5 gali 3', ['address']],
  ])('%s', (text, kinds) => {
    expect(findPersonalData(text)).toEqual(kinds);
  });

  it.each([
    'How can I contact the team?',
    'Do you ship to Canada?',
    'What is your return policy for 2026?',
    'Delivery on 2026-09-27 at 10:30',
    'Is the price AED 120?',
    'کیا آپ کینیڈا بھیجتے ہیں؟',
  ])('finds nothing in "%s"', (text) => {
    expect(findPersonalData(text)).toEqual([]);
  });
});

describe('redactPersonalData', () => {
  it('replaces each value with its kind and keeps the rest', () => {
    expect(
      redactPersonalData('Call me on +92 300 1234567 about NL-1048, or ayesha@example.com'),
    ).toBe('Call me on [phone] about [reference], or [email]');
    expect(redactPersonalData('Nothing personal here.')).toBe('Nothing personal here.');
  });
});
