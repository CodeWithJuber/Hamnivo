import type { QuotaInfo } from '@hamnivo/contracts';
import { LIMIT_KEYS, type LimitKey } from '@hamnivo/domain/billing';
import { AppError } from './app-error.js';

/** What a staff member or an integration hears when a plan limit stops an action. */
const LIMIT_DETAIL: Record<LimitKey, string> = {
  conversations: 'The plan allows no more conversations this billing period.',
  aiReplies: 'The plan allows no more AI replies this billing period.',
  aiTokens: 'The plan allows no more AI tokens this billing period.',
  knowledgeStorageBytes:
    'The knowledge base has reached the storage in the plan. Remove documents or change the plan.',
  seats:
    'Every seat in the plan is taken by a member or a pending invitation. Free a seat or change the plan.',
  webhookEndpoints:
    'The plan allows no more webhook endpoints. Remove one you no longer use or change the plan.',
};

export function planLimitError(
  limit: LimitKey,
  numbers: { max: number | null; used: number | null; resetsAt: Date | null },
): AppError {
  const quota: QuotaInfo = {
    scope: 'plan',
    limit,
    max: numbers.max,
    used: numbers.used,
    resetsAt: numbers.resetsAt?.toISOString() ?? null,
  };
  return new AppError('PLAN_LIMIT_REACHED', { detail: LIMIT_DETAIL[limit], quota });
}

/**
 * The database guards capacity limits (seats, knowledge storage) with SQLSTATE HN402: DETAIL
 * names the limit and HINT carries `{ max, used }`. This turns such an error, also when wrapped
 * by Drizzle, into PLAN_LIMIT_REACHED (HTTP 402).
 */
export function planLimitFromDatabase(error: unknown): AppError | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const { code, detail, hint } = current as { code?: unknown; detail?: unknown; hint?: unknown };
    if (code === 'HN402') {
      const limit = (LIMIT_KEYS as readonly string[]).includes(String(detail))
        ? (detail as LimitKey)
        : null;
      if (!limit) return null;
      let numbers: { max?: unknown; used?: unknown } = {};
      try {
        numbers = JSON.parse(String(hint)) as typeof numbers;
      } catch {
        numbers = {};
      }
      const int = (value: unknown) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      return planLimitError(limit, {
        max: int(numbers.max),
        used: int(numbers.used),
        resetsAt: null,
      });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}
