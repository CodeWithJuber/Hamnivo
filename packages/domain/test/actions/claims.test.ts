import { describe, expect, it } from 'vitest';
import { checkActionClaims, findActionClaims } from '../../src/actions/index.js';

const CHANGE_CLAIMS = [
  "I've updated your delivery address.",
  'I have changed the delivery date to Friday.',
  'We have cancelled your appointment.',
  'Your address has been updated.',
  'The booking has now been rescheduled for Monday.',
  'Your subscription is now upgraded.',
  'All done! Your password was successfully reset.',
  "It's done.",
  'Address update kar diya hai.',
  'Aapka order cancel ho gaya hai.',
  'मैंने आपका पता अपडेट कर दिया है।',
  'میں نے آپ کا پتہ تبدیل کر دیا ہے۔',
  'تم تحديث عنوانك بنجاح.',
];

const CHECK_CLAIMS = [
  "I've checked your order and it is on its way.",
  'I have looked up your booking.',
  'Maine order check kar liya hai.',
  'تحققت من طلبك.',
];

/** Honest statements: pending, future, negated, conditional, asked-about or someone else's. */
const NOT_CLAIMS = [
  'I have prepared the address change for your approval. Nothing has changed yet.',
  'Your address change is waiting for your approval.',
  'Once your address has been updated, you will get an email.',
  'If the booking was successfully rescheduled, the card will say so.',
  'Has your address been updated?',
  'I cannot change your address myself, but a person can help.',
  "I haven't updated anything yet.",
  'The address will be updated after you approve.',
  'The result is not confirmed yet; we are checking before trying again.',
  'Our return policy allows returns within 30 days.',
  'Your payment has been confirmed.',
  'Agar address update ho gaya to aapko email milegi.',
];

describe('findActionClaims', () => {
  it.each(CHANGE_CLAIMS)('finds a change claim in %j', (text) => {
    expect(findActionClaims(text).map((c) => c.claim)).toContain('action_completed');
  });

  it.each(CHECK_CLAIMS)('finds a lookup claim in %j', (text) => {
    expect(findActionClaims(text).map((c) => c.claim)).toContain('action_checked');
  });

  it.each(NOT_CLAIMS)('finds no claim in %j', (text) => {
    expect(findActionClaims(text)).toEqual([]);
  });
});

describe('checkActionClaims', () => {
  const none = { completedChanges: 0, completedLookups: 0, pending: 0 };

  it('blocks a change claim without a succeeded receipt', () => {
    const verdict = checkActionClaims("I've updated your address.", none);
    expect(verdict.ok).toBe(false);
  });

  it('allows it with a succeeded receipt and nothing pending', () => {
    expect(
      checkActionClaims("I've updated your address.", { ...none, completedChanges: 1 }),
    ).toEqual({ ok: true });
  });

  it('blocks it while another action is still pending or unconfirmed', () => {
    expect(
      checkActionClaims("I've updated your address.", { ...none, completedChanges: 1, pending: 1 })
        .ok,
    ).toBe(false);
  });

  it('allows a lookup claim after any completed action, not before', () => {
    expect(checkActionClaims("I've checked your order.", none).ok).toBe(false);
    expect(checkActionClaims("I've checked your order.", { ...none, completedLookups: 1 })).toEqual(
      {
        ok: true,
      },
    );
  });

  it('passes text without claims', () => {
    expect(checkActionClaims('Here is our return policy.', none)).toEqual({ ok: true });
  });
});
