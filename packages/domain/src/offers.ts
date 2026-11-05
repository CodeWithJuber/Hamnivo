import type { LanguageSlice } from './decisions.js';

/**
 * Hand-off offered to one person at a time (HNV-10-03, HNV-10-06, H02): who is offered a
 * conversation next. Only people who are online right now, are not holding another offer and are
 * under their open-chat limit can be offered one; among them, those who speak the customer's
 * language come first, then those with the fewest open chats, then whoever waited longest since
 * their last offer. Nobody is offered the same hand-off twice.
 */

/** After this many people, the conversation waits in the team's queue instead. */
export const MAX_OFFER_ROUNDS = 3;

export const OFFER_DECLINE_REASONS = [
  'at_capacity',
  'not_my_area',
  'going_offline',
  'other',
] as const;
export type OfferDeclineReason = (typeof OFFER_DECLINE_REASONS)[number];

export interface OfferCandidate {
  id: string;
  status: 'online' | 'away' | 'offline';
  /** The language slices they answer in. */
  languages: readonly LanguageSlice[];
  /** Open conversations they handle now. */
  openChats: number;
  /** Null: no limit. */
  maxOpenChats: number | null;
  /** They are holding an offer for another conversation right now. */
  holdingOffer: boolean;
  /** When they were last offered a conversation; null: never. */
  lastOfferedAt: Date | null;
}

/**
 * Whether someone who answers in `languages` can answer a customer writing in `slice`: the same
 * slice, or its script variant (Hinglish is Hindi in Latin letters; Roman Urdu is Urdu).
 */
export function speaks(languages: readonly LanguageSlice[], slice: LanguageSlice): boolean {
  if (languages.includes(slice)) return true;
  const kin: Partial<Record<LanguageSlice, LanguageSlice>> = {
    hinglish: 'hi',
    hi: 'hinglish',
    'roman-urdu': 'ur',
    ur: 'roman-urdu',
  };
  const related = kin[slice];
  return related !== undefined && languages.includes(related);
}

/** Whether a person can be offered a conversation now, whatever its language. */
export function canBeOffered(candidate: OfferCandidate): boolean {
  return (
    candidate.status === 'online' &&
    !candidate.holdingOffer &&
    (candidate.maxOpenChats === null || candidate.openChats < candidate.maxOpenChats)
  );
}

/** The person to offer the conversation to next, or null when nobody can take it. */
export function chooseOfferee<T extends OfferCandidate>(
  candidates: readonly T[],
  options: {
    /** The customer's language, and others their words fit equally well. */
    language: LanguageSlice | null;
    alternatives?: readonly LanguageSlice[];
    /** People already offered this hand-off. */
    exclude: ReadonlySet<string>;
  },
): T | null {
  const wanted = options.language ? [options.language, ...(options.alternatives ?? [])] : [];
  const fit = (c: T) => (wanted.some((slice) => speaks(c.languages, slice)) ? 0 : 1);
  const waited = (c: T) => c.lastOfferedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const ranked = candidates
    .filter((c) => !options.exclude.has(c.id) && canBeOffered(c))
    .sort(
      (a, b) =>
        fit(a) - fit(b) ||
        a.openChats - b.openChats ||
        waited(a) - waited(b) ||
        a.id.localeCompare(b.id),
    );
  return ranked[0] ?? null;
}
