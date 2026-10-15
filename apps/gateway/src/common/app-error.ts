import type { ErrorCode, Problem, ProblemOwner, QuotaInfo } from '@hamnivo/contracts';

export interface AppErrorDetails {
  detail?: string;
  fields?: { path: string; message: string }[];
  retryAfter?: number;
  retryable?: boolean;
  /** Which limit was reached (plan, budget or rate limit). */
  quota?: QuotaInfo;
  /** A finer machine-readable reason (Problem.reason). */
  reason?: string;
  /** OWNERSHIP_CHANGED: who has the conversation now (Problem.currentOwner). */
  currentOwner?: ProblemOwner;
  /** AI_DRAFT_CLOSED: how the draft ended and who decided it (Problem.aiDraft). */
  aiDraft?: NonNullable<Problem['aiDraft']>;
  /** Logged for operators, never sent to clients. */
  internal?: unknown;
}

/** An expected failure with a stable public error code (rendered as RFC 9457 problem details). */
export class AppError extends Error {
  override name = 'AppError';
  constructor(
    readonly code: ErrorCode,
    readonly details: AppErrorDetails = {},
  ) {
    super(details.detail ?? code);
  }
}
