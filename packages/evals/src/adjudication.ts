import {
  detectLanguage,
  type LanguageSlice,
  type ReplyLanguage,
  resolveReplyLanguage,
} from '@hamnivo/domain';
import { groupBy, type Rate, wilson } from './stats.js';
import { statesValue } from './text.js';
import type { AdjudicationCorpus, Responder, ReviewStatus } from './types.js';

/** What a native-speaker reviewer fills in (U14). Nothing here is filled by a machine. */
export interface Review {
  status: ReviewStatus;
  reviewer: string | null;
  /** Does the reply mean what the facts say? */
  meaning: 'correct' | 'partly' | 'wrong' | null;
  /** Is the tone right for a customer in this language? */
  tone: 'appropriate' | 'too_formal' | 'too_casual' | 'rude' | null;
  /** Is it the customer's language and script? */
  language: 'right' | 'wrong_language' | 'wrong_script' | null;
  notes: string | null;
}

/** One case for review: the scenario, what the system said and the automatic checks. */
export interface ReviewPacket {
  id: string;
  scenario: string;
  slice: LanguageSlice;
  message: string;
  evidence: string[];
  expectedLanguage: ReplyLanguage;
  /** The language the product chose from the message and the customer's interface locale. */
  chosenLanguage: ReplyLanguage;
  reply: string;
  responder: string;
  auto: {
    /** The product chose the slice's language (U01). */
    languageChosen: boolean;
    /** The reply reads as that language (detection over the reply). */
    replyLanguage: boolean;
    /** Every fact value is stated (null when the right answer is to offer a person). */
    facts: boolean | null;
  };
  reviewNotes: string;
  review: Review;
}

const EMPTY_REVIEW: Review = {
  status: 'pending_native_review',
  reviewer: null,
  meaning: null,
  tone: null,
  language: null,
  notes: null,
};

/** Runs each scenario in each slice and returns packets awaiting native review. */
export async function buildReviewPackets(
  corpus: AdjudicationCorpus,
  responder: Responder,
  options: { scenarios?: readonly string[]; slices?: readonly LanguageSlice[] } = {},
): Promise<ReviewPacket[]> {
  const packets: ReviewPacket[] = [];
  for (const scenario of corpus.scenarios) {
    if (options.scenarios && !options.scenarios.includes(scenario.id)) continue;
    for (const [slice, message] of Object.entries(scenario.messages) as [LanguageSlice, string][]) {
      if (options.slices && !options.slices.includes(slice)) continue;
      const expectedLanguage = corpus.replyLanguages[slice];
      const chosenLanguage = resolveReplyLanguage({
        detection: detectLanguage(message),
        uiLocale: corpus.locales[slice],
      }).language;
      const reply = await responder.reply({
        evidence: scenario.evidence,
        messages: [message],
        language: chosenLanguage,
      });
      packets.push({
        id: `${scenario.id}:${slice}`,
        scenario: scenario.id,
        slice,
        message,
        evidence: scenario.evidence,
        expectedLanguage,
        chosenLanguage,
        reply,
        responder: responder.name,
        auto: {
          languageChosen: chosenLanguage === expectedLanguage,
          replyLanguage: detectLanguage(reply).candidates.includes(expectedLanguage),
          facts: scenario.offersPerson
            ? null
            : scenario.facts.every((value) => statesValue(reply, value)),
        },
        reviewNotes: scenario.reviewNotes,
        review: { ...EMPTY_REVIEW },
      });
    }
  }
  return packets;
}

export interface SliceSummary {
  cases: number;
  pending: number;
  reviewed: number;
  auto: { languageChosen: Rate; replyLanguage: Rate; facts: Rate };
  /** From native reviews only; n/a until someone has reviewed the slice. */
  meaningCorrect: Rate;
  toneAppropriate: Rate;
  languageRight: Rate;
}

export interface AdjudicationSummary {
  suite: 'adjudication';
  cases: number;
  pending: number;
  bySlice: Record<string, SliceSummary>;
}

function sliceSummary(packets: readonly ReviewPacket[]): SliceSummary {
  const reviewed = packets.filter((p) => p.review.status === 'reviewed');
  const withFacts = packets.filter((p) => p.auto.facts !== null);
  return {
    cases: packets.length,
    pending: packets.length - reviewed.length,
    reviewed: reviewed.length,
    auto: {
      languageChosen: wilson(packets.filter((p) => p.auto.languageChosen).length, packets.length),
      replyLanguage: wilson(packets.filter((p) => p.auto.replyLanguage).length, packets.length),
      facts: wilson(withFacts.filter((p) => p.auto.facts).length, withFacts.length),
    },
    meaningCorrect: wilson(
      reviewed.filter((p) => p.review.meaning === 'correct').length,
      reviewed.filter((p) => p.review.meaning !== null).length,
    ),
    toneAppropriate: wilson(
      reviewed.filter((p) => p.review.tone === 'appropriate').length,
      reviewed.filter((p) => p.review.tone !== null).length,
    ),
    languageRight: wilson(
      reviewed.filter((p) => p.review.language === 'right').length,
      reviewed.filter((p) => p.review.language !== null).length,
    ),
  };
}

/** Per-slice automatic checks and, where native speakers have reviewed, meaning and tone. */
export function summarizeAdjudication(packets: readonly ReviewPacket[]): AdjudicationSummary {
  return {
    suite: 'adjudication',
    cases: packets.length,
    pending: packets.filter((p) => p.review.status !== 'reviewed').length,
    bySlice: Object.fromEntries(
      [...groupBy(packets, (p) => p.slice)].map(([slice, list]) => [slice, sliceSummary(list)]),
    ),
  };
}

/** A reviewer's sheet for one slice: each case with blanks to fill in the JSON packet. */
export function reviewSheet(slice: string, packets: readonly ReviewPacket[]): string {
  const lines = [
    `# Native review: ${slice}`,
    '',
    'Status: pending native review. For each case, fill `review` in the JSON packet:',
    '`meaning` (correct, partly, wrong), `tone` (appropriate, too_formal, too_casual, rude),',
    '`language` (right, wrong_language, wrong_script), your name as `reviewer` and any `notes`,',
    'then set `status` to `reviewed`.',
    '',
  ];
  for (const p of packets) {
    lines.push(
      `## ${p.id}`,
      '',
      `- Customer: ${p.message}`,
      `- Facts given: ${p.evidence.join(' ') || '(none: the assistant should offer a person)'}`,
      `- Reply (${p.responder}, ${p.chosenLanguage}): ${p.reply}`,
      `- Automatic checks: language chosen ${p.auto.languageChosen ? 'yes' : 'no'}, reply language ${p.auto.replyLanguage ? 'yes' : 'no'}, facts ${p.auto.facts === null ? 'n/a' : p.auto.facts ? 'yes' : 'no'}`,
      `- What to check: ${p.reviewNotes}`,
      '',
    );
  }
  return lines.join('\n');
}
