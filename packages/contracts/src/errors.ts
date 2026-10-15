import { z } from 'zod';
import { Timestamp } from './common.js';

/**
 * Machine-readable error codes (blueprint §9). Messages shown to people are safe summaries; they
 * never reveal secrets, internal paths or whether a resource exists in another tenant.
 */
export const ErrorCode = z.enum([
  'AUTH_REQUIRED',
  'SESSION_EXPIRED',
  'REAUTH_REQUIRED',
  'MFA_REQUIRED',
  'SCOPE_DENIED',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_CONFLICT',
  'VERSION_CONFLICT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PLAN_LIMIT_REACHED',
  'IDENTITY_REQUIRED',
  'CONSENT_REQUIRED',
  'CHAT_UNAVAILABLE',
  'ASSERTION_INVALID',
  'ACTION_REQUIRES_APPROVAL',
  'APPROVAL_EXPIRED',
  'APPROVAL_MISMATCH',
  'ACTION_OUTCOME_UNKNOWN',
  'UPLOAD_REJECTED',
  'UPLOAD_TOO_LARGE',
  'PROVIDER_UNAVAILABLE',
  'AUTHORITY_UNAVAILABLE',
  'OWNERSHIP_CHANGED',
  'CONVERSATION_CLOSED',
  'RESYNC_REQUIRED',
  'FEATURE_DISABLED',
  'QUOTE_EXPIRED',
  'CAPABILITY_UNSUPPORTED',
  'SEPARATE_APPROVER_REQUIRED',
  'DELETE_WINDOW_CLOSED',
  'CHANNEL_WINDOW_CLOSED',
  'AI_DRAFT_CLOSED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** HTTP status and default retry guidance per code. */
export const ERROR_DEFAULTS: Record<
  ErrorCode,
  { status: number; retryable: boolean; title: string }
> = {
  AUTH_REQUIRED: { status: 401, retryable: false, title: 'Sign-in required' },
  SESSION_EXPIRED: { status: 401, retryable: false, title: 'Session expired' },
  REAUTH_REQUIRED: { status: 401, retryable: false, title: 'Please confirm it is you' },
  MFA_REQUIRED: { status: 401, retryable: false, title: 'Verification code required' },
  SCOPE_DENIED: { status: 403, retryable: false, title: 'Not allowed' },
  ORIGIN_NOT_ALLOWED: {
    status: 403,
    retryable: false,
    title: 'This site is not allowed to use the widget',
  },
  NOT_FOUND: { status: 404, retryable: false, title: 'Not found' },
  VALIDATION_FAILED: { status: 422, retryable: false, title: 'Some information needs attention' },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    retryable: false,
    title: 'This request was already sent with different content',
  },
  VERSION_CONFLICT: { status: 409, retryable: false, title: 'Someone else changed this first' },
  RATE_LIMITED: { status: 429, retryable: true, title: 'Too many requests' },
  QUOTA_EXCEEDED: { status: 429, retryable: false, title: 'Usage limit reached' },
  PLAN_LIMIT_REACHED: {
    status: 402,
    retryable: false,
    title: 'The plan limit for this is reached',
  },
  IDENTITY_REQUIRED: { status: 403, retryable: false, title: 'Please sign in to continue' },
  CONSENT_REQUIRED: { status: 403, retryable: false, title: 'Please agree before chatting' },
  CHAT_UNAVAILABLE: { status: 403, retryable: false, title: 'Chat isn’t available right now' },
  ASSERTION_INVALID: { status: 401, retryable: false, title: 'Identity could not be verified' },
  ACTION_REQUIRES_APPROVAL: { status: 409, retryable: false, title: 'Approval required' },
  APPROVAL_EXPIRED: { status: 409, retryable: false, title: 'Approval expired' },
  APPROVAL_MISMATCH: { status: 409, retryable: false, title: 'The request changed after approval' },
  ACTION_OUTCOME_UNKNOWN: { status: 202, retryable: false, title: 'Outcome not yet confirmed' },
  UPLOAD_REJECTED: { status: 422, retryable: false, title: 'File rejected' },
  UPLOAD_TOO_LARGE: { status: 413, retryable: false, title: 'File too large' },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true, title: 'Service temporarily unavailable' },
  AUTHORITY_UNAVAILABLE: {
    status: 503,
    retryable: true,
    title: 'Messages cannot be delivered right now',
  },
  OWNERSHIP_CHANGED: {
    status: 409,
    retryable: false,
    title: 'Another participant now owns this conversation',
  },
  CONVERSATION_CLOSED: { status: 409, retryable: false, title: 'This conversation is closed' },
  RESYNC_REQUIRED: { status: 410, retryable: true, title: 'History must be reloaded' },
  FEATURE_DISABLED: { status: 403, retryable: false, title: 'This feature is turned off' },
  QUOTE_EXPIRED: {
    status: 409,
    retryable: false,
    title: 'This price has expired. Please review the order again.',
  },
  CAPABILITY_UNSUPPORTED: {
    status: 422,
    retryable: false,
    title: 'This store does not support that',
  },
  SEPARATE_APPROVER_REQUIRED: {
    status: 403,
    retryable: false,
    title: 'Someone other than the requester must approve this',
  },
  DELETE_WINDOW_CLOSED: {
    status: 409,
    retryable: false,
    title: 'This message can no longer be deleted',
  },
  CHANNEL_WINDOW_CLOSED: {
    status: 409,
    retryable: false,
    title: 'This channel only allows template messages now',
  },
  AI_DRAFT_CLOSED: {
    status: 409,
    retryable: false,
    title: 'This AI draft is no longer waiting for review',
  },
  INTERNAL: { status: 500, retryable: true, title: 'Something went wrong on our side' },
};

/** Which limit a 402 or 429 response is about, so a client can say so and back off correctly. */
export const QuotaInfo = z
  .object({
    /** The plan, the workspace's own budget, one API key or one client address. */
    scope: z.enum(['plan', 'budget', 'api_key', 'address']),
    /** The limit reached, e.g. `conversations`, `aiTokens` or `requestsPerMinute`. */
    limit: z.string(),
    max: z.int().nonnegative().nullable(),
    used: z.int().nonnegative().nullable(),
    /** When the limit resets, if it does. */
    resetsAt: Timestamp.nullable(),
  })
  .meta({ id: 'QuotaInfo' });
export type QuotaInfo = z.infer<typeof QuotaInfo>;

export const ProblemOwner = z
  .object({
    kind: z.enum(['staff', 'ai', 'external', 'none']),
    displayName: z.string().nullable(),
    ownershipEpoch: z.int().nonnegative(),
  })
  .meta({ id: 'ProblemOwner' });
export type ProblemOwner = z.infer<typeof ProblemOwner>;

/** RFC 9457 problem details with Hamnivo extension members. */
export const Problem = z
  .object({
    type: z.string().meta({ description: 'URI identifying the problem type' }),
    title: z.string(),
    status: z.int().min(100).max(599),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: ErrorCode,
    retryable: z.boolean(),
    requestId: z.string(),
    /** Seconds to wait before retrying, when known. */
    retryAfter: z.int().min(0).optional(),
    /** A finer machine-readable reason, such as why a file was refused (`malware_detected`). */
    reason: z.string().max(60).optional(),
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    quota: QuotaInfo.optional(),
    /**
     * OWNERSHIP_CHANGED: who has the conversation now, so a lost claim can say so. Only sent to
     * people who may read the conversation.
     */
    currentOwner: ProblemOwner.optional(),
    /** AI_DRAFT_CLOSED: how the draft ended, and who decided it when a person did. */
    aiDraft: z
      .object({
        state: z.enum(['pending', 'approved', 'edited', 'rejected', 'superseded']),
        decidedBy: z.string().nullable(),
      })
      .optional(),
  })
  .meta({ id: 'Problem', description: 'RFC 9457 problem details' });
export type Problem = z.infer<typeof Problem>;

export const PROBLEM_TYPE_BASE = 'https://hamnivo.dev/problems/';

export function problem(
  code: ErrorCode,
  requestId: string,
  overrides: Partial<Omit<Problem, 'code' | 'requestId' | 'type'>> = {},
): Problem {
  const defaults = ERROR_DEFAULTS[code];
  return {
    type: `${PROBLEM_TYPE_BASE}${code.toLowerCase().replaceAll('_', '-')}`,
    title: defaults.title,
    status: defaults.status,
    retryable: defaults.retryable,
    code,
    requestId,
    ...overrides,
  };
}
