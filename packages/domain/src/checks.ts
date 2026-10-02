import { DEFAULT_DECISION_THRESHOLDS, PERSON_REQUEST_QUESTION } from './decision-questions.js';
import {
  type AnyAnswer,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionAnswers,
  type DecisionResult,
  gateAnswer,
  LANGUAGE_SLICES,
  type LanguageSlice,
  type NoulAnswer,
  type NoulQuestion,
  type QuestionThreshold,
} from './decisions.js';

/**
 * Checks a decision provider (Jev) runs around an AI reply (blueprint §12). Each asks bounded
 * questions about a minimized state; code decides what the answers mean. A check can only hold a
 * reply, drop a passage or hand the conversation to people. It never grants a permission,
 * approves an action or unlocks data, whatever the customer wrote.
 *
 * Every check uses the decision machinery: a versioned rubric per brand with thresholds per
 * language slice, `shadow` (record only) before `live`, and a record of each decision with its
 * usage and latency. A language without thresholds was not evaluated: the check abstains there
 * and Hamnivo behaves as it does without it.
 */
export const CHECK_TASKS = ['answer-check', 'escalation'] as const;
export type CheckTask = (typeof CHECK_TASKS)[number];

export const isCheckTask = (value: unknown): value is CheckTask =>
  typeof value === 'string' && (CHECK_TASKS as readonly string[]).includes(value);

export type ThresholdKind = 'choice' | 'noul';

export interface CheckTaskSpec {
  /** Version of the questions' wording. Thresholds measured for one version do not carry over. */
  questionsVersion: number;
  /**
   * Threshold keys staff set per language, with their answer type. Fan-out questions share
   * their kind's threshold: every claim of an answer check uses `relation`.
   */
  thresholds: Readonly<Record<string, ThresholdKind>>;
  /** Whose language picks the thresholds: the customer's message, or the reply being checked. */
  slice: 'message' | 'reply';
}

export const CHECK_TASK_SPECS: Readonly<Record<CheckTask, CheckTaskSpec>> = {
  'answer-check': { questionsVersion: 1, thresholds: { relation: 'choice' }, slice: 'reply' },
  escalation: {
    questionsVersion: 1,
    thresholds: {
      wants_person: 'noul',
      frustrated: 'noul',
      unresolved: 'noul',
      complaint: 'noul',
      legal_threat: 'noul',
      safety: 'noul',
    },
    slice: 'message',
  },
};

/** Thresholds of a check rubric: by language slice, then threshold key. */
export type CheckThresholds = Readonly<
  Partial<Record<LanguageSlice, Readonly<Record<string, QuestionThreshold>>>>
>;

/**
 * Starting thresholds measured live for the evaluated model (docs/evals), by task. A task or
 * language without them abstains until someone sets them from what shadow mode recorded.
 */
export const DEFAULT_CHECK_THRESHOLDS: Readonly<Partial<Record<CheckTask, CheckThresholds>>> = {
  // Only the request for a person was measured (docs/evals/jev-1.13.0-2026-10-02.md).
  escalation: Object.fromEntries(
    LANGUAGE_SLICES.flatMap((slice) => {
      const band = DEFAULT_DECISION_THRESHOLDS.personRequest[slice];
      return band ? [[slice, { wants_person: { type: 'noul' as const, ...band } }]] : [];
    }),
  ),
};

// ---------------------------------------------------------------------------------------------
// Thresholds, one question at a time

/** A provider result after per-question thresholds. */
export interface GatedAnswers {
  /** `decided`: each answer was held to its own threshold. Otherwise nothing may be used. */
  status: 'decided' | 'abstained' | 'unavailable' | 'invalid';
  reason: string | null;
  /** Per question: the answer kept by its threshold (a noul gains its verdict), or null. */
  kept: Readonly<Record<string, AnyAnswer | null>>;
  /** Per question that fell short: why. */
  shortfalls: Readonly<Record<string, string>>;
  /** What the provider answered before thresholds, for the record. */
  observed: Readonly<Record<string, AnyAnswer>>;
}

/**
 * Holds each answer to its own threshold, unlike `applyThreshold`, which sets the whole result
 * aside when one answer falls short: a check asks many independent questions and one unsure
 * answer must not hide the others. A result from another provider, model or rubric than the
 * thresholds were set for, or a language without thresholds, abstains as a whole.
 */
export function gateCheck(
  result: DecisionResult<DecisionAnswers>,
  expected: { provider: string; modelVersion: string; rubricVersion: string },
  thresholds: Readonly<Record<string, QuestionThreshold>> | undefined,
  keyOf: (question: string) => string = (question) => question,
): GatedAnswers {
  const empty = { kept: {}, shortfalls: {}, observed: {} };
  if (result.status === 'unavailable' || result.status === 'invalid') {
    return { status: result.status, reason: result.reason, ...empty };
  }
  if (result.status === 'abstained') {
    return {
      status: 'abstained',
      reason: result.reason,
      ...empty,
      observed: result.observed ?? {},
    };
  }
  const observed = result.value;
  if (
    result.provider !== expected.provider ||
    result.modelVersion !== expected.modelVersion ||
    result.rubricVersion !== expected.rubricVersion
  ) {
    return {
      status: 'abstained',
      reason:
        `thresholds were set for ${expected.provider} ${expected.modelVersion} (${expected.rubricVersion}), ` +
        `not ${result.provider} ${result.modelVersion} (${result.rubricVersion})`,
      kept: {},
      shortfalls: {},
      observed,
    };
  }
  if (!thresholds) {
    return {
      status: 'abstained',
      reason: `not evaluated for this language (${result.language ?? 'unknown'})`,
      kept: {},
      shortfalls: {},
      observed,
    };
  }
  const kept: Record<string, AnyAnswer | null> = {};
  const shortfalls: Record<string, string> = {};
  for (const [name, answer] of Object.entries(observed)) {
    const key = keyOf(name);
    const outcome = gateAnswer(
      name,
      answer,
      Object.hasOwn(thresholds, key) ? thresholds[key] : undefined,
    );
    if (typeof outcome === 'string') {
      kept[name] = null;
      shortfalls[name] = outcome;
    } else {
      kept[name] = outcome;
    }
  }
  return { status: 'decided', reason: null, kept, shortfalls, observed };
}

/** The answers as a record keeps them: labels and numbers only, never state or text. */
export function answersRecord(gated: GatedAnswers): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(gated.observed).map(([name, answer]) => {
      const kept = gated.kept[name] ?? null;
      const base =
        answer.type === 'noul'
          ? { type: 'noul', probability: answer.probability }
          : answer.type === 'choice'
            ? { type: 'choice', label: answer.label, confidence: answer.confidence }
            : { type: 'score', score: answer.score, confidence: answer.confidence };
      return [
        name,
        {
          ...base,
          kept: kept !== null,
          ...(kept?.type === 'noul' && kept.verdict !== undefined ? { verdict: kept.verdict } : {}),
        },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Answer check: each sentence that cites a passage, against that passage

const TERMINATORS = new Set(['.', '!', '?', '؟', '۔', '।']);
const CLOSERS = new Set(['"', "'", ')', '”', '’', '»']);
const CITATIONS_AHEAD = /^[ \t]*(?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\])+/;
const CITATION = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/g;

/**
 * Splits a reply into sentences at `.`, `!`, `?`, `؟`, `۔`, `।` and line breaks. Citation markers
 * right after a sentence's end belong to that sentence, and a line of markers alone belongs to
 * the sentence before it. A full stop followed by another character (1.5, e.g.) ends nothing.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  const push = (part: string) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const previous = sentences.length - 1;
    if (trimmed.replace(CITATION, '').trim() === '' && previous >= 0) {
      sentences[previous] = `${sentences[previous]} ${trimmed}`;
      return;
    }
    sentences.push(trimmed);
  };
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === '\n') {
      push(text.slice(start, i));
      start = i + 1;
      i += 1;
      continue;
    }
    if (TERMINATORS.has(ch)) {
      const next = text.charAt(i + 1);
      if (ch === '.' && next !== '' && !/\s/.test(next) && next !== '[' && !CLOSERS.has(next)) {
        i += 1;
        continue;
      }
      let end = i + 1;
      while (
        end < text.length &&
        (TERMINATORS.has(text.charAt(end)) || CLOSERS.has(text.charAt(end)))
      )
        end += 1;
      const markers = CITATIONS_AHEAD.exec(text.slice(end));
      if (markers) end += markers[0].length;
      push(text.slice(start, end));
      start = end;
      i = end;
      continue;
    }
    i += 1;
  }
  push(text.slice(start));
  return sentences;
}

/** A sentence of a reply that cites knowledge passages. */
export interface CitedClaim {
  /** Position of the sentence in the reply, from 0. */
  sentence: number;
  /** The sentence without its citation markers. */
  text: string;
  /** The passages it cites, as positions in the list the model saw, from 0. */
  passages: number[];
}

/**
 * The sentences of a reply that cite passages, read from the model's own text (before citations
 * are renumbered for the customer), so each number still points at the passage the model saw.
 * Numbers that match no passage are left out, as they are when the reply is published.
 */
export function citedClaims(text: string, passageCount: number): CitedClaim[] {
  return splitSentences(text).flatMap((sentence, index) => {
    const numbers = [...sentence.matchAll(CITATION)].flatMap((match) =>
      (match[1] ?? '').split(',').map((part) => Number(part.trim())),
    );
    const passages = [...new Set(numbers.filter((n) => n >= 1 && n <= passageCount))].map(
      (n) => n - 1,
    );
    if (passages.length === 0) return [];
    const claim = sentence
      .replace(CITATION, '')
      .replace(/[ \t]+([.,;:!?؟۔।])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (claim.replace(/[\s.,;:!?؟۔।]/g, '') === '') return [];
    return [{ sentence: index, text: claim, passages }];
  });
}

export const ANSWER_RELATIONS = ['supports', 'contradicts', 'says_nothing'] as const;
export type AnswerRelation = (typeof ANSWER_RELATIONS)[number];

/**
 * How one passage relates to one claim: the citation check of TypeSafe's cookbook, with the
 * state's parts named in the question so Jev reads the right pair.
 */
export function relationQuestion(claim: number, passage: number): ChoiceQuestion<AnswerRelation> {
  const c = `claim_${claim}`;
  const p = `passage_${passage}`;
  return {
    type: 'choice',
    instructions: `How does ${p} relate to ${c}?`,
    labels: {
      supports: `${p} states ${c} or directly implies that it is true`,
      contradicts: `${p} states the opposite of ${c} or implies that it is false`,
      says_nothing: `${p} does not address what ${c} asserts, either way`,
    },
  };
}

/** Claim and passage pairs checked in one call; more are left unchecked (and so not supported). */
export const ANSWER_CHECK_MAX_PAIRS = 12;
/** Characters of each passage the check reads. */
export const ANSWER_CHECK_PASSAGE_CHARS = 2000;

export interface AnswerCheckPair {
  /** The question's name, such as `c1_p2`. */
  question: string;
  /** Position of the claim in the claims checked. */
  claim: number;
  /** Position of the passage in the list the model saw. */
  passage: number;
}

/**
 * One fan-out request for a reply: each claim and each passage once in the state, and one
 * question per pair. Only the claims and the passages they cite are sent.
 */
export function answerCheckRequest(
  claims: readonly CitedClaim[],
  passages: readonly string[],
): {
  state: Record<string, string>;
  questions: Record<string, ChoiceQuestion<AnswerRelation>>;
  pairs: AnswerCheckPair[];
  unchecked: number;
} {
  const state: Record<string, string> = {};
  const questions: Record<string, ChoiceQuestion<AnswerRelation>> = {};
  const pairs: AnswerCheckPair[] = [];
  const numbered = new Map<number, number>();
  let unchecked = 0;
  claims.forEach((claim, c) => {
    for (const passage of claim.passages) {
      if (pairs.length >= ANSWER_CHECK_MAX_PAIRS) {
        unchecked += 1;
        continue;
      }
      state[`claim_${c + 1}`] = claim.text;
      let p = numbered.get(passage);
      if (p === undefined) {
        p = numbered.size + 1;
        numbered.set(passage, p);
        state[`passage_${p}`] = (passages[passage] ?? '').slice(0, ANSWER_CHECK_PASSAGE_CHARS);
      }
      const question = `c${c + 1}_p${p}`;
      questions[question] = relationQuestion(c + 1, p);
      pairs.push({ question, claim: c, passage });
    }
  });
  return { state, questions, pairs, unchecked };
}

/** Every answer-check question shares the `relation` threshold. */
export const answerCheckThresholdKey = (_question: string) => 'relation';

export type ClaimVerdict = 'supported' | 'unsupported' | 'unsure';

export interface AnswerCheckVerdict {
  /**
   * `pass`: every cited sentence is supported. `fail`: one is contradicted, or no passage it
   * cites says anything about it. `unsure`: otherwise (an answer below its threshold, or a pair
   * left unchecked).
   */
  verdict: 'pass' | 'fail' | 'unsure';
  claims: { sentence: number; verdict: ClaimVerdict }[];
}

/**
 * What the answers mean, sentence by sentence. A sentence is supported when a passage it cites
 * supports it and none contradicts it; unsupported when one contradicts it, or when every
 * passage it cites says nothing about it.
 */
export function answerCheckVerdict(
  claims: readonly CitedClaim[],
  pairs: readonly AnswerCheckPair[],
  gated: GatedAnswers,
): AnswerCheckVerdict {
  const verdicts = claims.map((claim, c): { sentence: number; verdict: ClaimVerdict } => {
    const mine = pairs.filter((pair) => pair.claim === c);
    const answers = mine.map((pair) => gated.kept[pair.question] as ChoiceAnswer | null);
    const labels = answers.map((answer) => answer?.label ?? null);
    const complete = mine.length === claim.passages.length && labels.every((l) => l !== null);
    let verdict: ClaimVerdict = 'unsure';
    if (labels.includes('contradicts')) verdict = 'unsupported';
    else if (labels.includes('supports')) verdict = 'supported';
    else if (complete && labels.every((l) => l === 'says_nothing')) verdict = 'unsupported';
    return { sentence: claim.sentence, verdict };
  });
  const verdict = verdicts.some((v) => v.verdict === 'unsupported')
    ? 'fail'
    : verdicts.every((v) => v.verdict === 'supported')
      ? 'pass'
      : 'unsure';
  return { verdict, claims: verdicts };
}

/** What the model is told when it writes the reply again without the sentences that failed. */
export function answerCheckCorrection(sentences: readonly string[]): string {
  return [
    'These sentences of your previous draft are not supported by the passages they cite:',
    ...sentences.map((sentence) => `- ${JSON.stringify(sentence)}`),
    'Write the reply again without them. State only what a passage says, and cite it. If the ' +
      'passages do not answer the question, say that you do not have that information and offer a person.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Escalation advice (J04): does this conversation need a person?

/**
 * The escalation questions, one exact condition each; code combines them. A request for a person
 * is the evaluated question routing also asks: the deterministic detector answers first and always
 * wins, so Jev only adds the hand-offs it missed.
 */
export const ESCALATION_QUESTIONS = {
  wants_person: PERSON_REQUEST_QUESTION,
  frustrated: {
    type: 'noul',
    instructions: 'Is the customer frustrated or angry?',
    outcomes: {
      true: 'The customer sounds frustrated, annoyed or angry',
      false: 'The customer sounds calm, neutral or pleased',
    },
  },
  unresolved: {
    type: 'noul',
    instructions: 'Does the customer say that a problem they reported before is still not solved?',
    outcomes: {
      true: 'The customer says the same problem is still happening, or is still not fixed after an earlier attempt or promise',
      false: 'The customer does not say that an earlier problem is still not solved',
    },
  },
  complaint: {
    type: 'noul',
    instructions: 'Does the customer say they want to make a complaint about the business?',
    outcomes: {
      true: 'The customer makes a complaint about the business or its service, or asks how to make one',
      false: 'The customer does not make or ask to make a complaint',
    },
  },
  legal_threat: {
    type: 'noul',
    instructions: 'Does the customer threaten legal action against the business?',
    outcomes: {
      true: 'The customer mentions a lawyer, a court case, suing, or reporting the business to a regulator or the police',
      false: 'The customer does not threaten legal action',
    },
  },
  safety: {
    type: 'noul',
    instructions: "Does the customer describe a risk to someone's health or safety?",
    outcomes: {
      true: 'The customer describes an injury, an illness, a fire, an allergic reaction or a product that is dangerous',
      false: 'The customer does not describe a risk to health or safety',
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type EscalationReason =
  | 'wants_person'
  | 'safety'
  | 'legal_threat'
  | 'complaint'
  | 'unresolved_and_frustrated';

/** Customer messages the escalation check reads: the latest few, oldest first. */
export const ESCALATION_MESSAGES = 3;

const said = (gated: GatedAnswers, question: string) =>
  (gated.kept[question] as NoulAnswer | null | undefined)?.verdict === true;

/**
 * What the answers mean, in code. Each of these alone needs a person: a request for one, a risk
 * to health or safety, a legal threat or a complaint. Frustration alone does not; frustration
 * with a problem that is still not solved does. Only answers that met their threshold count.
 */
export function escalationVerdict(gated: GatedAnswers): {
  escalate: boolean;
  reasons: EscalationReason[];
} {
  const reasons: EscalationReason[] = [];
  if (said(gated, 'wants_person')) reasons.push('wants_person');
  if (said(gated, 'safety')) reasons.push('safety');
  if (said(gated, 'legal_threat')) reasons.push('legal_threat');
  if (said(gated, 'complaint')) reasons.push('complaint');
  if (said(gated, 'unresolved') && said(gated, 'frustrated')) {
    reasons.push('unresolved_and_frustrated');
  }
  return { escalate: reasons.length > 0, reasons };
}
