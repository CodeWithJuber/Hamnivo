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
