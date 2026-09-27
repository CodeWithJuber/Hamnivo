/**
 * Typed decisions (ADR 0006, blueprint §12): a provider-neutral port for bounded judgments. A
 * provider answers named questions about a minimized state. It suggests intent, ranks finite
 * candidates and evaluates bounded rubrics. It never authorizes, never computes money or dates and
 * never writes replies. Code applies thresholds and policy to what it returns.
 */

/** Language slices that thresholds and evaluations are kept for. */
export const LANGUAGE_SLICES = ['en', 'hinglish', 'roman-urdu', 'ar', 'hi', 'ur'] as const;
export type LanguageSlice = (typeof LANGUAGE_SLICES)[number];

export type DecisionJson =
  | string
  | number
  | boolean
  | null
  | DecisionJson[]
  | { [key: string]: DecisionJson };

/** The minimized state a provider judges: text, a JSON object or array, or null. */
export type DecisionState = string | DecisionJson[] | { [key: string]: DecisionJson } | null;

/** Selects one of a finite set of labels. A description may be null. */
export interface ChoiceQuestion<L extends string = string> {
  type: 'choice';
  instructions: string;
  labels: { readonly [K in L]: string | null };
}

/** Evaluates an ordered rubric. Level 0 is the lowest. */
export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  rubric: readonly [string | null, string | null, ...(string | null)[]];
}

/** Asks how likely a proposition is to be true. */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  outcomes?: { true?: string | null; false?: string | null };
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** Questions keyed by name. Keyed maps, never arrays (E08). */
export type DecisionQuestions = Readonly<Record<string, DecisionQuestion>>;

export interface ChoiceAnswer<L extends string = string> {
  type: 'choice';
  label: L;
  /** The provider's confidence in the label, from 0 to 1. */
  confidence: number;
  /** Probability per offered label, from 0 to 1. */
  probabilities: Readonly<Partial<Record<L, number>>>;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected score. It can fall between rubric levels. */
  score: number;
  confidence: number;
  /** Probability per rubric level, keyed '0', '1', … */
  probabilities: Readonly<Record<string, number>>;
}

/** Noul has no confidence by design. Never synthesize one. */
export interface NoulAnswer {
  type: 'noul';
  /** Probability that the proposition is true, from 0 to 1. */
  probability: number;
  /** Set only by `applyThreshold`, from the policy's band. Providers never set it. */
  verdict?: boolean;
}

export type AnswerFor<Q extends DecisionQuestion> =
  Q extends ChoiceQuestion<infer L>
    ? ChoiceAnswer<L>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export type DecisionAnswers<Q extends DecisionQuestions = DecisionQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>;
};

export interface DecisionRequest<Q extends DecisionQuestions = DecisionQuestions> {
  /** What is being decided, such as 'handoff-advisory'. Thresholds and audit are keyed by it. */
  task: string;
  /** Version of these questions. Thresholds hold only for the version they were evaluated on. */
  rubricVersion: string;
  /** Only the fields this task needs. */
  state: DecisionState;
  questions: Q;
  language?: LanguageSlice;
  signal?: AbortSignal;
  /** Total deadline for this call. Overrides the provider default (1500 ms on the chat path). */
  deadlineMs?: number;
}

export interface DecisionUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Recorded with every result, whatever its status (J07). */
export interface DecisionAudit {
  /** Provider id, such as 'jev'. */
  provider: string;
  task: string;
  rubricVersion: string;
  language?: LanguageSlice;
  /** Wall-clock time of the call, including calls that failed or timed out. */
  latencyMs: number;
  /** The model version that answered, when one did. */
  modelVersion?: string;
  usage?: DecisionUsage;
  /** The provider's id for the request, for support and cost reconciliation. */
  requestId?: string;
  /** Version of the threshold policy applied, when one was. */
  policyVersion?: string;
}

/** Why a provider could not answer. */
export type UnavailableReason =
  | 'deadline'
  | 'aborted'
  | 'rate_limited'
  | 'server_error'
  | 'connection'
  | 'auth'
  | 'not_found'
  | 'circuit_open'
  | 'error';

/**
 * The provider result. `unavailable` never means false, safe or approved. It is separate from the
 * routing outcome that policy chooses afterwards.
 */
export type DecisionResult<T> =
  | (DecisionAudit & {
      status: 'decided';
      value: T;
      modelVersion: string;
      /** For single-value results. Keyed answers carry their own and leave these unset. */
      probabilities?: Record<string, number>;
      confidence?: number;
    })
  | (DecisionAudit & {
      status: 'abstained';
      reason: string;
      /** What the provider answered before a threshold set it aside. For audit only, never for routing. */
      observed?: T;
    })
  | (DecisionAudit & {
      status: 'unavailable';
      retryable: boolean;
      reason: UnavailableReason;
      retryAfterMs?: number;
    })
  | (DecisionAudit & { status: 'invalid'; reason: string });

/**
 * A source of typed decisions. `decide` never rejects: every failure is a result status, so ordinary
 * messaging never depends on a provider being up.
 */
export interface DecisionProvider {
  readonly id: string;
  decide<const Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<DecisionResult<DecisionAnswers<Q>>>;
}

/** Routing outcomes (blueprint §21). Policy chooses one; a provider result status is not one. */
export const ROUTING_OUTCOMES = [
  'AI_CONTINUE',
  'ASK_CLARIFICATION',
  'INVITE_SPECIALIST',
  'HUMAN_REVIEW',
  'HUMAN_TAKEOVER',
  'BLOCK_ACTION',
] as const;
export type RoutingOutcome = (typeof ROUTING_OUTCOMES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

function questionProblem(question: unknown): string | undefined {
  if (!isRecord(question)) return 'must be an object';
  if (typeof question.instructions !== 'string') return 'instructions must be text';
  switch (question.type) {
    case 'choice': {
      if (!isRecord(question.labels)) return 'labels must be a map of label to description';
      const labels = Object.keys(question.labels);
      if (labels.length < 2) return 'offer at least two labels';
      return labels.some((label) => label.trim() === '') ? 'labels must not be empty' : undefined;
    }
    case 'score':
      return Array.isArray(question.rubric) && question.rubric.length >= 2
        ? undefined
        : 'the rubric needs at least two levels';
    case 'noul':
      return undefined;
    default:
      return 'type must be choice, score or noul';
  }
}

/** Returns why a request cannot be sent, or undefined when it can. */
export function validateDecisionRequest(request: DecisionRequest): string | undefined {
  if (!isText(request.task)) return 'task is required';
  if (!isText(request.rubricVersion)) return 'rubricVersion is required';
  if (request.state === undefined) return 'state is required (use null for none)';
  if (request.language !== undefined && !LANGUAGE_SLICES.includes(request.language)) {
    return `unknown language slice "${String(request.language)}"`;
  }
  const { deadlineMs } = request;
  if (deadlineMs !== undefined && !(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    return 'deadlineMs must be a positive number';
  }
  if (!isRecord(request.questions)) return 'questions must be a map keyed by question name';
  const entries = Object.entries(request.questions);
  if (entries.length === 0) return 'at least one question is required';
  for (const [name, question] of entries) {
    if (name.trim() === '') return 'question names must not be empty';
    const problem = questionProblem(question);
    if (problem) return `question "${name}": ${problem}`;
  }
  return undefined;
}

export type QuestionThreshold =
  | { type: 'choice'; minConfidence: number }
  | { type: 'score'; minConfidence: number }
  /** Noul thresholds apply to the probability: true at or above, false at or below, abstain between. */
  | { type: 'noul'; trueAtLeast: number; falseAtMost: number };

export interface TaskThresholds {
  /** Thresholds hold only for the provider, model and rubric they were evaluated with. */
  provider: string;
  modelVersion: string;
  rubricVersion: string;
  /** By language slice, then question name. A missing language was not evaluated: abstain. */
  languages: Readonly<Partial<Record<LanguageSlice, Readonly<Record<string, QuestionThreshold>>>>>;
}

export interface ThresholdPolicy {
  version: string;
  tasks: Readonly<Record<string, TaskThresholds>>;
}

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

type AnyAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Returns the answer to keep (a noul gains its verdict), or why it falls short. */
function gate(name: string, answer: AnyAnswer, threshold?: QuestionThreshold): AnyAnswer | string {
  if (!threshold) return `no threshold for "${name}"`;
  if (threshold.type !== answer.type) return `the threshold for "${name}" is for another type`;
  if (threshold.type === 'noul' && answer.type === 'noul') {
    const { trueAtLeast, falseAtMost } = threshold;
    if (!isUnit(trueAtLeast) || !isUnit(falseAtMost) || falseAtMost > trueAtLeast) {
      return `the threshold for "${name}" is malformed`;
    }
    const p = answer.probability;
    if (p >= trueAtLeast) return { ...answer, verdict: true };
    if (p <= falseAtMost) return { ...answer, verdict: false };
    return `"${name}" probability ${p} is between ${falseAtMost} and ${trueAtLeast}`;
  }
  if (threshold.type === 'noul' || answer.type === 'noul') return `no threshold for "${name}"`;
  if (!isUnit(threshold.minConfidence)) return `the threshold for "${name}" is malformed`;
  return answer.confidence >= threshold.minConfidence
    ? answer
    : `"${name}" confidence ${answer.confidence} is below ${threshold.minConfidence}`;
}

/**
 * Applies per-task and per-language thresholds to a decided result. An answer below its threshold,
 * or a task, language, provider, model or rubric that was not evaluated, makes the whole result
 * `abstained`, with the reason and the observed answers kept for audit. Other statuses pass through.
 */
export function applyThreshold<T extends DecisionAnswers>(
  result: DecisionResult<T>,
  policy: ThresholdPolicy,
): DecisionResult<T> {
  if (result.status !== 'decided') return { ...result, policyVersion: policy.version };
  const abstain = (reason: string): DecisionResult<T> => {
    const { value, probabilities, confidence, ...audit } = result;
    return {
      ...audit,
      policyVersion: policy.version,
      status: 'abstained',
      reason,
      observed: value,
    };
  };

  const task = Object.hasOwn(policy.tasks, result.task) ? policy.tasks[result.task] : undefined;
  if (!task) return abstain(`no thresholds for task "${result.task}"`);
  if (
    task.provider !== result.provider ||
    task.modelVersion !== result.modelVersion ||
    task.rubricVersion !== result.rubricVersion
  ) {
    return abstain(
      `thresholds were evaluated for ${task.provider} ${task.modelVersion} (rubric ${task.rubricVersion}), ` +
        `not ${result.provider} ${result.modelVersion} (rubric ${result.rubricVersion})`,
    );
  }
  if (!result.language) return abstain('no language slice: not evaluated for this language');
  const thresholds = task.languages[result.language];
  if (!thresholds) return abstain(`not evaluated for this language (${result.language})`);

  const kept: [string, AnyAnswer][] = [];
  const failures: string[] = [];
  for (const [name, answer] of Object.entries(result.value as DecisionAnswers)) {
    const outcome = gate(
      name,
      answer,
      Object.hasOwn(thresholds, name) ? thresholds[name] : undefined,
    );
    if (typeof outcome === 'string') failures.push(outcome);
    else kept.push([name, outcome]);
  }
  if (failures.length > 0) return abstain(failures.join('; '));
  return { ...result, policyVersion: policy.version, value: Object.fromEntries(kept) as T };
}
