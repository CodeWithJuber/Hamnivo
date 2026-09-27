import type {
  ChoiceAnswer,
  ChoiceQuestion,
  DecisionResult,
  LanguageSlice,
  UnavailableReason,
} from './decisions.js';
import { normalizeForMatching } from './human-request.js';

/**
 * Intent and team routing (J02, U07, blueprint §12 and §21). A decision provider may suggest the
 * intent, as a choice over the brand's own intents plus `other`. Code picks the team: only a team
 * that is active and accepting conversations for this brand can be chosen, and teams that speak the
 * customer's language come first. A deterministic keyword baseline answers whenever the provider
 * abstains, fails or is too slow. Routing picks a destination only: it never decides whether a
 * customer who asked for a person gets one.
 */

/** The label every routing question offers for "none of these, or unclear". */
export const OTHER_INTENT = 'other';

export interface RoutingIntent {
  /** Stable key, such as `billing`. Lowercase letters, digits, `-` and `_`. */
  key: string;
  /** What the intent covers, in plain words. Shown to the provider as the label's description. */
  description: string;
  /** Words and phrases the deterministic baseline matches, in any language. */
  keywords: readonly string[];
}

export interface RoutingTeam {
  id: string;
  /** Intents this team handles. A default team also takes what no other team handles. */
  intents: readonly string[];
  /** Languages people in the team can answer in. */
  languages: readonly LanguageSlice[];
  /** Languages the team can answer through a reviewed translation path. */
  translationLanguages?: readonly LanguageSlice[];
  /** Active and taking conversations now. Only such teams are permitted destinations. */
  accepting: boolean;
  isDefault?: boolean;
}

export const INTENT_KEY = /^[a-z][a-z0-9_-]{0,39}$/;

/** Returns why a set of intents cannot be used for routing, or undefined. */
export function validateIntents(intents: readonly RoutingIntent[]): string | undefined {
  if (intents.length === 0) return 'add at least one intent';
  const seen = new Set<string>();
  for (const intent of intents) {
    if (!INTENT_KEY.test(intent.key)) return `intent key "${intent.key}" is not valid`;
    if (intent.key === OTHER_INTENT) return `"${OTHER_INTENT}" is added automatically`;
    if (seen.has(intent.key)) return `intent "${intent.key}" is listed twice`;
    seen.add(intent.key);
    if (intent.description.trim() === '') return `intent "${intent.key}" needs a description`;
  }
  return undefined;
}

/** The routing question for a provider: one choice over the brand's intents plus `other`. */
export function routingQuestion(intents: readonly RoutingIntent[]): ChoiceQuestion {
  const labels: Record<string, string | null> = {};
  for (const intent of intents) labels[intent.key] = intent.description;
  labels[OTHER_INTENT] = 'None of these, or not clear from the messages';
  return {
    type: 'choice',
    instructions:
      'Which of these topics is the customer asking about? Choose "other" when none fits or the messages do not say.',
    labels,
  };
}

export interface BaselineIntent {
  intent: string;
  /** Keywords that matched, per intent, for the audit (configured words, never customer text). */
  matches: Readonly<Record<string, number>>;
  /** Two intents matched equally often, so the baseline chose `other`. */
  tie: boolean;
}

/**
 * The deterministic baseline: counts keyword matches per intent over the normalized text (spelling,
 * script variants and diacritics folded as for human-request detection). The most matched intent
 * wins; no match or a tie gives `other`.
 */
export function baselineIntent(text: string, intents: readonly RoutingIntent[]): BaselineIntent {
  const haystack = ` ${normalizeForMatching(text)} `;
  const matches: Record<string, number> = {};
  for (const intent of intents) {
    let count = 0;
    for (const keyword of intent.keywords) {
      const needle = normalizeForMatching(keyword);
      if (needle && haystack.includes(` ${needle} `)) count += 1;
    }
    if (count > 0) matches[intent.key] = count;
  }
  const ranked = Object.entries(matches).sort((a, b) => b[1] - a[1]);
  const [best, next] = ranked;
  if (!best) return { intent: OTHER_INTENT, matches, tie: false };
  if (next && next[1] === best[1]) return { intent: OTHER_INTENT, matches, tie: true };
  return { intent: best[0], matches, tie: false };
}

export type LanguageMatch = 'native' | 'translation' | 'none' | 'unknown';

export interface TeamChoice {
  teamId: string | null;
  languageMatch: LanguageMatch;
  /** `intent`: a team that handles the intent; `default`: a default team; `none`: no team fits. */
  basis: 'intent' | 'default' | 'none';
}

/** The customer's language, and languages that serve them equally when detection was ambiguous. */
type Wanted = { language: LanguageSlice | null; alternatives: readonly LanguageSlice[] };

function languageRank(team: RoutingTeam, wanted: Wanted): number {
  if (!wanted.language) return 0;
  const acceptable = [wanted.language, ...wanted.alternatives];
  if (acceptable.some((l) => team.languages.includes(l))) return 0;
  if (acceptable.some((l) => team.translationLanguages?.includes(l))) return 1;
  return 2;
}

function matchOf(team: RoutingTeam, wanted: Wanted): LanguageMatch {
  if (!wanted.language) return 'unknown';
  return (['native', 'translation', 'none'] as const)[languageRank(team, wanted)] ?? 'none';
}

/**
 * Picks the team for an intent and language (U07). Only accepting teams are permitted. Among the
 * teams that handle the intent, one that speaks the language beats one with a reviewed translation
 * path, which beats a language gap. Without such a team, the default teams are considered the same
 * way. Ties keep the given order. `alternatives` are languages that serve the customer as well,
 * such as Roman Urdu for a message that could equally be Hinglish.
 */
export function chooseTeam(input: {
  intent: string;
  language: LanguageSlice | null;
  alternatives?: readonly LanguageSlice[];
  teams: readonly RoutingTeam[];
}): TeamChoice {
  const wanted: Wanted = { language: input.language, alternatives: input.alternatives ?? [] };
  const permitted = input.teams.filter((team) => team.accepting);
  const best = (teams: RoutingTeam[]) =>
    teams
      .map((team, index) => ({ team, index, rank: languageRank(team, wanted) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)[0]?.team;
  const forIntent =
    input.intent === OTHER_INTENT
      ? []
      : permitted.filter((team) => team.intents.includes(input.intent));
  const byIntent = best(forIntent);
  if (byIntent) {
    return {
      teamId: byIntent.id,
      languageMatch: matchOf(byIntent, wanted),
      basis: 'intent',
    };
  }
  const byDefault = best(permitted.filter((team) => team.isDefault));
  if (byDefault) {
    return {
      teamId: byDefault.id,
      languageMatch: matchOf(byDefault, wanted),
      basis: 'default',
    };
  }
  return { teamId: null, languageMatch: input.language ? 'none' : 'unknown', basis: 'none' };
}

export interface StaffCandidate {
  id: string;
  languages: readonly LanguageSlice[];
  available: boolean;
  /** Open conversations now; fewer comes first among equals. */
  load?: number;
}

/**
 * Orders people for a conversation in a language (U07): available first, then those who speak it,
 * then by current load. Nobody is removed; an assignment step applies its own capacity limits.
 */
export function rankStaffForLanguage<T extends StaffCandidate>(
  staff: readonly T[],
  language: LanguageSlice | null,
): T[] {
  return staff
    .map((person, index) => ({ person, index }))
    .sort((a, b) => {
      if (a.person.available !== b.person.available) return a.person.available ? -1 : 1;
      const speaks = (p: T) => (language && p.languages.includes(language) ? 0 : 1);
      return (
        speaks(a.person) - speaks(b.person) ||
        (a.person.load ?? 0) - (b.person.load ?? 0) ||
        a.index - b.index
      );
    })
    .map(({ person }) => person);
}

export type RouteSource = 'provider' | 'baseline';

/** Why the baseline decided instead of the provider. */
export type FallbackReason =
  | 'not_asked'
  | 'abstained'
  | 'unavailable'
  | 'invalid'
  | 'label_not_offered';

export interface RoutingDecision {
  intent: string;
  source: RouteSource;
  fallback: FallbackReason | null;
  /** The provider's reason when it was unavailable (deadline, circuit_open, …). */
  unavailable: UnavailableReason | null;
  team: TeamChoice;
  /**
   * The customer asked for a person. Routing only picked the team; the handoff itself happened
   * before and does not depend on this decision.
   */
  explicitRequest: boolean;
}

export type RoutingAnswers = { intent: ChoiceAnswer };

/**
 * Combines a provider result (after thresholds) with the baseline. A decided answer with an offered
 * intent is used; anything else falls back to the baseline and says why.
 */
export function decideRoute(input: {
  provider: DecisionResult<RoutingAnswers> | null;
  baseline: BaselineIntent;
  offered: readonly string[];
  language: LanguageSlice | null;
  alternatives?: readonly LanguageSlice[];
  teams: readonly RoutingTeam[];
  explicitRequest: boolean;
}): RoutingDecision {
  let intent = input.baseline.intent;
  let source: RouteSource = 'baseline';
  let fallback: FallbackReason | null = 'not_asked';
  let unavailable: UnavailableReason | null = null;
  const result = input.provider;
  if (result) {
    switch (result.status) {
      case 'decided': {
        const label = result.value.intent?.label;
        if (typeof label === 'string' && input.offered.includes(label)) {
          intent = label;
          source = 'provider';
          fallback = null;
        } else {
          fallback = 'label_not_offered';
        }
        break;
      }
      case 'abstained':
        fallback = 'abstained';
        break;
      case 'unavailable':
        fallback = 'unavailable';
        unavailable = result.reason;
        break;
      case 'invalid':
        fallback = 'invalid';
        break;
    }
  }
  return {
    intent,
    source,
    fallback,
    unavailable,
    team: chooseTeam({
      intent,
      language: input.language,
      alternatives: input.alternatives ?? [],
      teams: input.teams,
    }),
    explicitRequest: input.explicitRequest,
  };
}

// ---------------------------------------------------------------------------------------------
// Experiments (J08): provider versus baseline on recorded shadow decisions.

export interface ExperimentRecord {
  status: 'decided' | 'abstained' | 'unavailable' | 'invalid' | 'skipped';
  language: LanguageSlice | null;
  providerIntent: string | null;
  baselineIntent: string;
  /** A reviewer's label, when someone reviewed the decision. */
  reviewedIntent: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ExperimentSlice {
  records: number;
  decided: number;
  abstained: number;
  unavailable: number;
  invalid: number;
  /** Share of decided records where the provider and the baseline chose the same intent. */
  agreement: number | null;
  reviewed: number;
  /** Accuracy against reviewer labels, when there are any. */
  providerAccuracy: number | null;
  baselineAccuracy: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  inputTokens: number;
  outputTokens: number;
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

const ratio = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1e4) / 1e4;

function summarize(records: readonly ExperimentRecord[]): ExperimentSlice {
  const decided = records.filter((r) => r.status === 'decided');
  const agreeing = decided.filter((r) => r.providerIntent === r.baselineIntent);
  const reviewed = records.filter((r) => r.reviewedIntent !== null);
  const reviewedDecided = reviewed.filter((r) => r.status === 'decided');
  const latencies = records
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === 'number')
    .sort((a, b) => a - b);
  return {
    records: records.length,
    decided: decided.length,
    abstained: records.filter((r) => r.status === 'abstained').length,
    unavailable: records.filter((r) => r.status === 'unavailable').length,
    invalid: records.filter((r) => r.status === 'invalid').length,
    agreement: ratio(agreeing.length, decided.length),
    reviewed: reviewed.length,
    providerAccuracy: ratio(
      reviewedDecided.filter((r) => r.providerIntent === r.reviewedIntent).length,
      reviewedDecided.length,
    ),
    baselineAccuracy: ratio(
      reviewed.filter((r) => r.baselineIntent === r.reviewedIntent).length,
      reviewed.length,
    ),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens: records.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    outputTokens: records.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0),
  };
}

/**
 * Agreement, abstention, failures, latency and token use, overall and per language slice. Provider
 * failures are reported separately and never counted as agreement or disagreement. Accuracy needs
 * reviewer labels; without them it is null rather than estimated.
 */
export function summarizeExperiment(records: readonly ExperimentRecord[]): {
  overall: ExperimentSlice;
  byLanguage: Partial<Record<LanguageSlice | 'unknown', ExperimentSlice>>;
} {
  const groups = new Map<LanguageSlice | 'unknown', ExperimentRecord[]>();
  for (const record of records) {
    const key = record.language ?? 'unknown';
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return {
    overall: summarize(records),
    byLanguage: Object.fromEntries([...groups].map(([key, list]) => [key, summarize(list)])),
  };
}
