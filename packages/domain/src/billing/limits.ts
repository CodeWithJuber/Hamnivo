/**
 * Plan limits and usage (A08, A15). A limit is either counted per billing period (conversations,
 * AI replies, AI tokens: summed from the usage ledger) or a capacity measured when it is needed
 * (knowledge storage, seats, webhook endpoints). `null` means unlimited. Entitlements say how much
 * a workspace may use; they never grant permissions, which stay with roles.
 */

export const LIMIT_KEYS = [
  'conversations',
  'aiReplies',
  'aiTokens',
  'knowledgeStorageBytes',
  'seats',
  'webhookEndpoints',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export type PlanLimits = Record<LimitKey, number | null>;

export interface LimitSpec {
  kind: 'period' | 'capacity';
  /** Usage-ledger meters summed for a period limit. */
  meters: readonly string[];
  unit: 'conversation' | 'reply' | 'token' | 'byte' | 'seat' | 'endpoint';
}

export const LIMITS: Record<LimitKey, LimitSpec> = {
  conversations: { kind: 'period', meters: ['conversations'], unit: 'conversation' },
  aiReplies: { kind: 'period', meters: ['ai.replies'], unit: 'reply' },
  aiTokens: { kind: 'period', meters: ['ai.tokens.input', 'ai.tokens.output'], unit: 'token' },
  knowledgeStorageBytes: { kind: 'capacity', meters: [], unit: 'byte' },
  seats: { kind: 'capacity', meters: [], unit: 'seat' },
  webhookEndpoints: { kind: 'capacity', meters: [], unit: 'endpoint' },
};

/** Usage-ledger meters written by Hamnivo. */
export const METER = {
  conversations: 'conversations',
  aiReplies: 'ai.replies',
  aiTokensInput: 'ai.tokens.input',
  aiTokensOutput: 'ai.tokens.output',
} as const;

export const UNLIMITED: PlanLimits = {
  conversations: null,
  aiReplies: null,
  aiTokens: null,
  knowledgeStorageBytes: null,
  seats: null,
  webhookEndpoints: null,
};

/** Limits from stored JSON: unknown or invalid values count as unlimited, never as zero. */
export function parseLimits(value: unknown): PlanLimits {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const limits = { ...UNLIMITED };
  for (const key of LIMIT_KEYS) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) limits[key] = raw;
  }
  return limits;
}

/** Whether adding `increment` to `used` stays within `limit`. */
export function withinLimit(used: number, limit: number | null, increment = 1): boolean {
  return limit === null || used + increment <= limit;
}

export type UsageState = 'unlimited' | 'ok' | 'warning' | 'reached';

export interface UsageStatus {
  used: number;
  limit: number | null;
  remaining: number | null;
  /** Share of the limit used, 0–1 and above; null when unlimited. */
  ratio: number | null;
  state: UsageState;
}

/** Where usage stands against a limit. `warningAt` is a percentage (default 80). */
export function usageStatus(used: number, limit: number | null, warningAt = 80): UsageStatus {
  if (limit === null) return { used, limit, remaining: null, ratio: null, state: 'unlimited' };
  const ratio = limit === 0 ? (used > 0 ? Number.POSITIVE_INFINITY : 1) : used / limit;
  const state: UsageState = used >= limit ? 'reached' : ratio * 100 >= warningAt ? 'warning' : 'ok';
  return { used, limit, remaining: Math.max(0, limit - used), ratio, state };
}

export const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [80, 100];

/** Alert thresholds (percentages of `limit`) that `used` has reached. */
export function thresholdsReached(
  used: number,
  limit: number | null,
  thresholds: readonly number[] = DEFAULT_ALERT_THRESHOLDS,
): number[] {
  if (limit === null) return [];
  return [...thresholds]
    .filter((t) => t > 0 && t <= 100)
    .sort((a, b) => a - b)
    .filter((t) => used * 100 >= limit * t);
}

export type AiBlockReason = 'plan_replies' | 'plan_tokens' | 'budget_tokens';

export type AiAllowance =
  | { allowed: true }
  | { allowed: false; reason: AiBlockReason; limit: number; used: number };

/**
 * Whether the AI may start another reply this period: under the plan's reply and token limits
 * and under the workspace's own token budget. Token use is only known after a reply, so one
 * reply may pass the limit slightly; the next one is refused.
 */
export function aiAllowance(input: {
  limits: PlanLimits;
  budgetTokens: number | null;
  repliesUsed: number;
  tokensUsed: number;
}): AiAllowance {
  const { limits, budgetTokens, repliesUsed, tokensUsed } = input;
  if (limits.aiReplies !== null && repliesUsed >= limits.aiReplies) {
    return { allowed: false, reason: 'plan_replies', limit: limits.aiReplies, used: repliesUsed };
  }
  if (limits.aiTokens !== null && tokensUsed >= limits.aiTokens) {
    return { allowed: false, reason: 'plan_tokens', limit: limits.aiTokens, used: tokensUsed };
  }
  if (budgetTokens !== null && tokensUsed >= budgetTokens) {
    return { allowed: false, reason: 'budget_tokens', limit: budgetTokens, used: tokensUsed };
  }
  return { allowed: true };
}
