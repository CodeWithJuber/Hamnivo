import { describe, expect, it } from 'vitest';
import {
  adjudicationProblems,
  buildReviewPackets,
  loadAdjudicationCorpus,
  type ReviewPacket,
  referenceResponder,
  reviewSheet,
  summarizeAdjudication,
} from '../src/index.js';

const corpus = loadAdjudicationCorpus();

describe('native-language adjudication (U14)', () => {
  it('covers every supported slice in every scenario', () => {
    expect(adjudicationProblems(corpus)).toEqual([]);
    expect(corpus.review).toBe('pending_native_review');
  });

  it('builds review packets that wait for native speakers', async () => {
    const packets = await buildReviewPackets(corpus, referenceResponder, {
      scenarios: ['return-window', 'out-of-scope-repair'],
    });
    expect(packets).toHaveLength(12);
    for (const packet of packets) {
      // The product picks each slice's language, including Hinglish and Roman Urdu (U01).
      expect(packet.chosenLanguage, packet.id).toBe(packet.expectedLanguage);
      expect(packet.auto.replyLanguage, packet.id).toBe(true);
      expect(packet.review).toEqual({
        status: 'pending_native_review',
        reviewer: null,
        meaning: null,
        tone: null,
        language: null,
        notes: null,
      });
    }
    expect(packets.filter((p) => p.scenario === 'return-window').every((p) => p.auto.facts)).toBe(
      true,
    );
    expect(
      packets
        .filter((p) => p.scenario === 'out-of-scope-repair')
        .every((p) => p.auto.facts === null),
    ).toBe(true);
    const sheet = reviewSheet(
      'ur',
      packets.filter((p) => p.slice === 'ur'),
    );
    expect(sheet).toContain('Status: pending native review');
    expect(sheet).toContain('## return-window:ur');
  });

  it('reports meaning and tone only from native reviews, with confidence intervals', async () => {
    const packets = await buildReviewPackets(corpus, referenceResponder, {
      slices: ['roman-urdu'],
    });
    const pending = summarizeAdjudication(packets);
    expect(pending.pending).toBe(packets.length);
    expect(pending.bySlice['roman-urdu']?.meaningCorrect.rate).toBeNull();

    const reviewed: ReviewPacket[] = packets.map((packet, index) => ({
      ...packet,
      review: {
        status: 'reviewed',
        reviewer: 'test reviewer',
        meaning: index === 0 ? 'partly' : 'correct',
        tone: 'appropriate',
        language: 'right',
        notes: null,
      },
    }));
    const summary = summarizeAdjudication(reviewed).bySlice['roman-urdu'];
    expect(summary?.reviewed).toBe(packets.length);
    expect(summary?.meaningCorrect).toMatchObject({
      successes: packets.length - 1,
      total: packets.length,
    });
    expect(summary?.meaningCorrect.low).toBeLessThan(summary?.meaningCorrect.rate ?? 0);
  });
});
