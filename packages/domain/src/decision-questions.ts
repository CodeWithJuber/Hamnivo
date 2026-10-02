import type { ChoiceQuestion, LanguageSlice, NoulQuestion } from './decisions.js';

/**
 * Questions Hamnivo asks a decision provider, shared by the product and its evaluation
 * (`run-suite decisions` in @hamnivo/evals), so thresholds measured on one hold for the other.
 * Each asks one exact condition with criteria that say the same thing as the instructions (Jev
 * reads literally); counting, dates and money stay in code.
 */

/** The pinned provider version the default thresholds were evaluated on (docs/evals). */
export const EVALUATED_DECISION_MODEL = 'jev-1.13.0';

/**
 * Does the customer ask for a person (J04, U02)? The deterministic detector answers first and
 * always wins; a provider's answer can only add a hand-off, never block one.
 */
export const PERSON_REQUEST_QUESTION = {
  type: 'noul',
  instructions:
    'Is the customer asking to talk to a human person (a member of staff) instead of the AI assistant?',
  outcomes: {
    true: 'The customer asks for a person, a human, an agent or a member of staff',
    false: 'The customer does not ask for a person',
  },
} as const satisfies NoulQuestion;

/** The language slice of the customer's messages (U01). Script is known from the text itself. */
export const LANGUAGE_QUESTION = {
  type: 'choice',
  instructions: "In which language are the customer's messages written?",
  labels: {
    en: 'English',
    ar: 'Arabic, in Arabic script',
    hi: 'Hindi, in Devanagari script',
    ur: 'Urdu, in Urdu (Arabic) script',
    hinglish: 'Hindi written in Latin letters (Hinglish), often mixed with English words',
    'roman-urdu': 'Urdu written in Latin letters (Roman Urdu), often mixed with English words',
  },
} as const satisfies ChoiceQuestion<LanguageSlice>;

/** Starting thresholds for one pinned model, measured per language slice. */
export interface DecisionThresholdDefaults {
  model: string;
  /** The evaluation report the numbers come from. */
  evaluation: string;
  /** Routing intent: the minimum confidence, by the message's language slice. */
  routing: Readonly<Partial<Record<LanguageSlice, number>>>;
  /** Request for a person: true at or above, false at or below, by the message's slice. */
  personRequest: Readonly<
    Partial<Record<LanguageSlice, { trueAtLeast: number; falseAtMost: number }>>
  >;
  /**
   * Language: the minimum confidence by the language the provider answered, since the true
   * language is what is being decided. An answer without a value is never acted on.
   */
  language: Readonly<Partial<Record<LanguageSlice, number>>>;
}

/**
 * Thresholds from one live `run-suite decisions` run against jev-1.13.0
 * (docs/evals/jev-1.13.0-2026-10-02.md): routing at the lowest confidence where decided answers
 * were at least 95% right, a request for a person from the confidence where "true" answers were
 * at least 95% precise (never below 0.80), and language per answer at 95%. Jev's Hinglish answer
 * was Roman Urdu too often to be acted on, so it has no value and the widget keeps asking.
 */
export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholdDefaults = {
  model: EVALUATED_DECISION_MODEL,
  evaluation: 'docs/evals/jev-1.13.0-2026-10-02.md',
  routing: { en: 0.5, hinglish: 0.5, 'roman-urdu': 0.5, ar: 0.5, hi: 0.5, ur: 0.5 },
  personRequest: {
    en: { trueAtLeast: 0.8, falseAtMost: 0.5 },
    hinglish: { trueAtLeast: 0.8, falseAtMost: 0.5 },
    'roman-urdu': { trueAtLeast: 0.9, falseAtMost: 0.5 },
    ar: { trueAtLeast: 0.8, falseAtMost: 0.5 },
    hi: { trueAtLeast: 0.8, falseAtMost: 0.5 },
    ur: { trueAtLeast: 0.8, falseAtMost: 0.5 },
  },
  language: { en: 0.5, 'roman-urdu': 0.55, ar: 0.5, hi: 0.5, ur: 0.5 },
};
