import { describe, expect, it } from 'vitest';
import {
  applyMemoryCitations,
  coveringTombstone,
  type RecallCandidate,
  renderMemoryLine,
  selectRecall,
  sharedCacheEligibility,
} from '../src/index.js';

const now = new Date('2026-09-27T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

const candidate = (overrides: Partial<RecallCandidate> & Pick<RecallCandidate, 'id' | 'key'>) =>
  ({
    value: 'Email',
    kind: 'preference',
    sourceType: 'customer_statement',
    evidenceStatus: 'supported',
    status: 'active',
    version: 1,
    validFrom: daysAgo(10),
    validUntil: null,
    expiresAt: null,
    observedAt: daysAgo(10),
    recordedAt: daysAgo(10),
    supersededAt: null,
    supersedesId: null,
    supersededById: null,
    score: 0,
    ...overrides,
  }) satisfies RecallCandidate;

describe('recall into AI replies (G19)', () => {
  const language = candidate({ id: 'a', key: 'preferred_language', value: 'Urdu' });
  const delivery = candidate({
    id: 'b',
    key: 'delivery_note',
    value: 'Leave with reception',
    score: 0.9,
  });
  const interest = candidate({
    id: 'c',
    key: 'product_interest',
    value: 'Prayer mats',
    score: 0.1,
  });

  it('renders memories as numbered memories with source and date, never as chat', () => {
    expect(renderMemoryLine(language, 0)).toBe(
      '[M1] Preferred language: Urdu (customer message, 2026-09-17)',
    );
    const claim = candidate({
      id: 'o',
      key: 'stated_order_reference',
      kind: 'claim',
      value: '1042',
      evidenceStatus: 'unknown',
    });
    expect(renderMemoryLine(claim, 1)).toContain('not verified');
  });

  it('takes profile slots first, then the most relevant, within the budget', () => {
    const picked = selectRecall(
      [interest, delivery, language],
      { maxItems: 2, maxChars: 1000 },
      now,
    );
    expect(picked.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(picked.withheld).toEqual({ invalid: 0, duplicateSlot: 0, overBudget: 1 });
    const tight = selectRecall([interest, delivery, language], { maxItems: 5, maxChars: 80 }, now);
    expect(tight.items.map((i) => i.id)).toEqual(['a']);
  });

  it('never recalls pending, superseded, outdated, expired or future values', () => {
    const picked = selectRecall(
      [
        candidate({ id: 'p', key: 'contact_method', status: 'pending' }),
        candidate({ id: 's', key: 'contact_time', status: 'superseded', validUntil: daysAgo(1) }),
        candidate({ id: 'o', key: 'size_preference', status: 'outdated' }),
        candidate({ id: 'e', key: 'open_issue', expiresAt: daysAgo(1) }),
        candidate({
          id: 'f',
          key: 'product_interest',
          validFrom: new Date(now.getTime() + 60_000),
        }),
        language,
      ],
      { maxItems: 10, maxChars: 5000 },
      now,
    );
    expect(picked.items.map((i) => i.id)).toEqual(['a']);
    expect(picked.withheld.invalid).toBe(5);
  });

  it('recalls one value per slot', () => {
    const twice = candidate({
      id: 'a2',
      key: 'preferred_language',
      value: 'English',
      recordedAt: daysAgo(20),
    });
    const picked = selectRecall([twice, language], { maxItems: 10, maxChars: 5000 }, now);
    expect(picked.items.map((i) => i.id)).toEqual(['a']);
    expect(picked.withheld.duplicateSlot).toBe(1);
  });

  it('turns memory citations into a list of cited memories and removes them from the text', () => {
    const cited = applyMemoryCitations(
      'Salaam! As you told us before [M1], we will reply in Urdu [M2]. [M9]',
      [language, delivery],
    );
    expect(cited.text).toBe('Salaam! As you told us before, we will reply in Urdu.');
    expect(cited.cited).toEqual([language, delivery]);
    expect(applyMemoryCitations('No memory used.', [language]).cited).toEqual([]);
  });

  it('keeps anything built with personal memory out of shared caches (K09)', () => {
    expect(sharedCacheEligibility({ memoryItems: 0 })).toEqual({ eligible: true });
    expect(sharedCacheEligibility({ memoryItems: 2 })).toEqual({
      eligible: false,
      reason: 'personal_memory',
    });
  });
});

describe('deletion tombstones', () => {
  const tombstone = {
    scope: 'record' as const,
    key: 'delivery_note',
    sourceRefs: ['msg_1'],
    fingerprints: ['1:ab'],
    deletedAt: daysAgo(1),
  };
  const probe = {
    key: 'delivery_note',
    sourceRefs: ['msg_1'],
    fingerprints: ['1:ab'],
    observedAt: daysAgo(2),
  };

  it('covers the same slot, source or value observed before the deletion', () => {
    expect(coveringTombstone(probe, [tombstone])).toBe(tombstone);
    expect(coveringTombstone({ ...probe, key: 'x', fingerprints: [] }, [tombstone])).toBe(
      tombstone,
    );
    expect(coveringTombstone({ ...probe, key: 'x', sourceRefs: [] }, [tombstone])).toBe(tombstone);
    expect(
      coveringTombstone({ ...probe, key: 'x', sourceRefs: [], fingerprints: [] }, [tombstone]),
    ).toBeNull();
  });

  it('covers everything before an erasure of the whole customer', () => {
    const erased = {
      scope: 'subject' as const,
      key: null,
      sourceRefs: [],
      fingerprints: [],
      deletedAt: daysAgo(1),
    };
    expect(
      coveringTombstone({ ...probe, key: 'contact_method', sourceRefs: ['msg_9'] }, [erased]),
    ).toBe(erased);
  });

  it('does not cover evidence observed after the deletion', () => {
    expect(
      coveringTombstone({ ...probe, sourceRefs: ['msg_2'], observedAt: now }, [tombstone]),
    ).toBeNull();
  });

  it('never takes the deleted memory’s own message as evidence again, even with clock skew', () => {
    expect(coveringTombstone({ ...probe, key: 'x', observedAt: now }, [tombstone])).toBe(tombstone);
  });
});
