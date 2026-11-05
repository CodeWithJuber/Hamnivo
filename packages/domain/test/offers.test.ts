import { describe, expect, it } from 'vitest';
import { chooseOfferee, MAX_OFFER_ROUNDS, type OfferCandidate, speaks } from '../src/offers.js';

const person = (id: string, patch: Partial<OfferCandidate> = {}): OfferCandidate => ({
  id,
  status: 'online',
  languages: ['en'],
  openChats: 0,
  maxOpenChats: null,
  holdingOffer: false,
  lastOfferedAt: null,
  ...patch,
});
const none = new Set<string>();
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 10, minutes));

describe('who is offered a conversation (HNV-10-03)', () => {
  it('offers only people online, free of another offer and under their limit', () => {
    const people = [
      person('away', { status: 'away' }),
      person('offline', { status: 'offline' }),
      person('busy', { holdingOffer: true }),
      person('full', { openChats: 5, maxOpenChats: 5 }),
    ];
    expect(chooseOfferee(people, { language: 'en', exclude: none })).toBeNull();
    const free = person('free', { openChats: 4, maxOpenChats: 5 });
    expect(chooseOfferee([...people, free], { language: 'en', exclude: none })?.id).toBe('free');
  });

  it('prefers the customer’s language, then the fewest open chats, then the longest wait', () => {
    const ana = person('ana', { languages: ['en'], openChats: 0 });
    const bilal = person('bilal', { languages: ['ur'], openChats: 3 });
    expect(chooseOfferee([ana, bilal], { language: 'ur', exclude: none })?.id).toBe('bilal');
    // Nobody speaks it: still offered, to the least busy.
    expect(chooseOfferee([bilal, ana], { language: 'ar', exclude: none })?.id).toBe('ana');
    const chen = person('chen', { openChats: 0, lastOfferedAt: at(5) });
    const dina = person('dina', { openChats: 0, lastOfferedAt: at(1) });
    expect(chooseOfferee([chen, dina], { language: 'en', exclude: none })?.id).toBe('dina');
    const never = person('eve', { openChats: 0, lastOfferedAt: null });
    expect(chooseOfferee([chen, dina, never], { language: 'en', exclude: none })?.id).toBe('eve');
  });

  it('never offers the same hand-off twice to one person', () => {
    const ana = person('ana');
    const bilal = person('bilal', { openChats: 2 });
    expect(chooseOfferee([ana, bilal], { language: 'en', exclude: new Set(['ana']) })?.id).toBe(
      'bilal',
    );
    expect(chooseOfferee([ana], { language: 'en', exclude: new Set(['ana']) })).toBeNull();
  });

  it('counts Hindi for Hinglish and Urdu for Roman Urdu, and the other way round', () => {
    expect(speaks(['hi'], 'hinglish')).toBe(true);
    expect(speaks(['hinglish'], 'hi')).toBe(true);
    expect(speaks(['ur'], 'roman-urdu')).toBe(true);
    expect(speaks(['en'], 'roman-urdu')).toBe(false);
    const hindi = person('hindi', { languages: ['hi'], openChats: 4 });
    const english = person('english', { openChats: 0 });
    expect(chooseOfferee([english, hindi], { language: 'hinglish', exclude: none })?.id).toBe(
      'hindi',
    );
    // Words that fit several languages: a team member who speaks any of them counts.
    expect(
      chooseOfferee([english, person('urdu', { languages: ['ur'], openChats: 2 })], {
        language: 'hinglish',
        alternatives: ['roman-urdu'],
        exclude: none,
      })?.id,
    ).toBe('urdu');
  });

  it('stops after three people', () => {
    expect(MAX_OFFER_ROUNDS).toBe(3);
  });
});
