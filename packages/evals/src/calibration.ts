/**
 * Scores for probabilistic decisions: Brier score, expected calibration error, percentiles and the
 * threshold choices the product applies. Pure functions over recorded answers, so thresholds can be
 * chosen again without calling a provider.
 */

const round = (value: number, places = 4) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

/** One probabilistic answer: the probability given to each option, and the true option. */
export interface ScoredChoice {
  probabilities: Readonly<Record<string, number | undefined>>;
  truth: string;
}

/**
 * Multi-class Brier score: the mean over answers of Σ (p(option) − 1[option is true])². 0 is
 * perfect; always putting all the probability on a wrong option scores 2.
 */
export function brierChoice(answers: readonly ScoredChoice[]): number | null {
  if (answers.length === 0) return null;
  let total = 0;
  for (const answer of answers) {
    const options = new Set([...Object.keys(answer.probabilities), answer.truth]);
    for (const option of options) {
      const p = answer.probabilities[option] ?? 0;
      const y = option === answer.truth ? 1 : 0;
      total += (p - y) ** 2;
    }
  }
  return round(total / answers.length);
}

/** Binary Brier score: the mean of (p − y)². */
export function brierBinary(answers: readonly { p: number; y: boolean }[]): number | null {
  if (answers.length === 0) return null;
  const total = answers.reduce((sum, a) => sum + (a.p - (a.y ? 1 : 0)) ** 2, 0);
  return round(total / answers.length);
}

/**
 * Expected calibration error over equal-width bins: Σ (n_bin / N) · |mean(score) − mean(outcome)|.
 * For a choice the score is the confidence and the outcome whether the choice was right; for a
 * noul the score is the probability and the outcome whether the proposition was true.
 */
export function expectedCalibrationError(
  answers: readonly { score: number; outcome: boolean }[],
  bins = 10,
): number | null {
  if (answers.length === 0) return null;
  const buckets = Array.from({ length: bins }, () => ({ n: 0, score: 0, outcome: 0 }));
  for (const answer of answers) {
    const index = Math.min(bins - 1, Math.max(0, Math.floor(answer.score * bins)));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.n += 1;
    bucket.score += answer.score;
    bucket.outcome += answer.outcome ? 1 : 0;
  }
  const total = buckets.reduce(
    (sum, b) =>
      b.n === 0 ? sum : sum + (b.n / answers.length) * Math.abs((b.score - b.outcome) / b.n),
    0,
  );
  return round(total);
}

/** The value below which `p` percent of the sorted values fall (nearest rank). */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** The thresholds a choice is checked against: 0.30, 0.35, … 0.95. */
export const CHOICE_GRID = Array.from({ length: 14 }, (_, i) => round(0.3 + i * 0.05, 2));

export interface ChoiceThresholdOutcome {
  minConfidence: number;
  /** Answers at or above the threshold (the provider decides them). */
  decided: number;
  correct: number;
  /** Share set aside for the fixed rule (abstained). */
  abstention: number;
  /** Accuracy of the decided answers. */
  accuracy: number | null;
}

export function atChoiceThreshold(
  answers: readonly { confidence: number; correct: boolean }[],
  minConfidence: number,
): ChoiceThresholdOutcome {
  const decided = answers.filter((a) => a.confidence >= minConfidence);
  const correct = decided.filter((a) => a.correct).length;
  return {
    minConfidence,
    decided: decided.length,
    correct,
    abstention: answers.length === 0 ? 0 : round(1 - decided.length / answers.length),
    accuracy: decided.length === 0 ? null : round(correct / decided.length),
  };
}

/**
 * The lowest threshold on the grid at which the decided answers are at least `target` accurate,
 * with at least `minDecided` of them; null when none is, so the provider always abstains there.
 */
export function chooseChoiceThreshold(
  answers: readonly { confidence: number; correct: boolean }[],
  target = 0.9,
  minDecided = 5,
): ChoiceThresholdOutcome | null {
  for (const t of CHOICE_GRID) {
    const outcome = atChoiceThreshold(answers, t);
    if (outcome.decided >= minDecided && (outcome.accuracy ?? 0) >= target) return outcome;
  }
  return null;
}

export interface NoulBand {
  /** At or above: true. */
  trueAtLeast: number;
  /** At or below: false. Between the two the provider abstains. */
  falseAtMost: number;
  decided: number;
  correct: number;
  abstention: number;
  accuracy: number | null;
  /** Of the answers called true, the share that were true. */
  precision: number | null;
  /** Of the true propositions, the share called true. */
  recall: number | null;
}

export function atNoulBand(
  answers: readonly { p: number; y: boolean }[],
  trueAtLeast: number,
  falseAtMost: number,
): NoulBand {
  const yes = answers.filter((a) => a.p >= trueAtLeast);
  const no = answers.filter((a) => a.p <= falseAtMost);
  const decided = yes.length + no.length;
  const correct = yes.filter((a) => a.y).length + no.filter((a) => !a.y).length;
  const positives = answers.filter((a) => a.y).length;
  return {
    trueAtLeast,
    falseAtMost,
    decided,
    correct,
    abstention: answers.length === 0 ? 0 : round(1 - decided / answers.length),
    accuracy: decided === 0 ? null : round(correct / decided),
    precision: yes.length === 0 ? null : round(yes.filter((a) => a.y).length / yes.length),
    recall: positives === 0 ? null : round(yes.filter((a) => a.y).length / positives),
  };
}

/** Candidate bands: true at 0.50…0.95, false at 0.05…0.50 (never above the true bound). */
const TRUE_GRID = Array.from({ length: 10 }, (_, i) => round(0.5 + i * 0.05, 2));
const FALSE_GRID = Array.from({ length: 10 }, (_, i) => round(0.5 - i * 0.05, 2));

/**
 * The band for a noul: the lowest `trueAtLeast` whose "true" answers are at least `target`
 * precise, and the highest `falseAtMost` whose "false" answers are at least `target` right.
 * Null when the true side never reaches the target (the provider then never says true).
 */
export function chooseNoulBand(
  answers: readonly { p: number; y: boolean }[],
  target = 0.95,
  minTrue = 3,
): NoulBand | null {
  const trueAtLeast = TRUE_GRID.find((t) => {
    const yes = answers.filter((a) => a.p >= t);
    return yes.length >= minTrue && yes.filter((a) => a.y).length / yes.length >= target;
  });
  if (trueAtLeast === undefined) return null;
  const falseAtMost =
    FALSE_GRID.find((f) => {
      if (f > trueAtLeast) return false;
      const no = answers.filter((a) => a.p <= f);
      return no.length > 0 && no.filter((a) => !a.y).length / no.length >= target;
    }) ?? 0;
  return atNoulBand(answers, trueAtLeast, falseAtMost);
}
