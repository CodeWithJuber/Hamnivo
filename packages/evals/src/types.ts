import type { LanguageSlice, ReplyLanguage, UiLocale } from '@hamnivo/domain';

/** What a responder gets: the facts the assistant was given, the conversation and the language. */
export interface ReplyInput {
  /** Facts the assistant was given, as knowledge passages would be. */
  evidence: readonly string[];
  /** Customer turns, oldest first. */
  messages: readonly string[];
  /** The reply language the product chose (U01). */
  language: ReplyLanguage;
}

/** Something that answers a customer: the system under evaluation. */
export interface Responder {
  readonly name: string;
  reply(input: ReplyInput): Promise<string>;
}

/** How a reply treats a disputed fact. */
export type Stance = 'holds' | 'capitulates' | 'evasive';

/** Review state of a corpus or packet: machine-written text awaits native speakers. */
export type ReviewStatus = 'pending_native_review' | 'reviewed';

export interface SycophancyScenario {
  id: string;
  domain: string;
  slice: LanguageSlice;
  /** The facts the assistant has. */
  evidence: string[];
  /** Values a correct answer states (numbers, as written in any script). */
  truth: string[];
  /** The customer's wrong values under pressure. */
  claim: string[];
  /** The neutral question. */
  baseline: string;
  /** The same question under each kind of pressure. */
  pressure: Record<PressureKind, string>;
}

export const PRESSURE_KINDS = [
  'opposite_belief',
  'praise',
  'insistence',
  'authority',
  'emotional',
] as const;
export type PressureKind = (typeof PRESSURE_KINDS)[number];

export interface SycophancyCorpus {
  version: number;
  review: ReviewStatus;
  scenarios: SycophancyScenario[];
}

/** A product decision that must not change when an irrelevant detail changes (U13). */
export type FairnessDecision = 'routing' | 'handoff' | 'personal_data';
export type FairnessAttribute = 'name' | 'gender' | 'politeness' | 'script' | 'language';

export interface FairnessGroup {
  id: string;
  decision: FairnessDecision;
  /** The detail that differs between variants; everything relevant stays the same. */
  attribute: FairnessAttribute;
  /** The decision every variant should get. */
  expected: string;
  variants: Array<{ id: string; slice: LanguageSlice; text: string }>;
}

export interface RoutingIntentSpec {
  key: string;
  description: string;
  keywords: string[];
}

export interface FairnessCorpus {
  version: number;
  review: ReviewStatus;
  /** The topics routing chooses from, with keywords in each supported language. */
  rubric: RoutingIntentSpec[];
  groups: FairnessGroup[];
}

export interface AdjudicationScenario {
  id: string;
  domain: string;
  evidence: string[];
  /** Values a correct reply states; empty when the right answer is to offer a person. */
  facts: string[];
  /** The right answer is to say it is not known and offer a person. */
  offersPerson: boolean;
  /** What the reviewer checks beyond the facts. */
  reviewNotes: string;
  /** The customer's message per supported slice. */
  messages: Record<LanguageSlice, string>;
}

export interface AdjudicationCorpus {
  version: number;
  review: ReviewStatus;
  /** The interface locale each slice's customer uses (it breaks Hinglish/Roman Urdu ties). */
  locales: Record<LanguageSlice, UiLocale>;
  /** The reply language each slice expects. */
  replyLanguages: Record<LanguageSlice, ReplyLanguage>;
  scenarios: AdjudicationScenario[];
}
