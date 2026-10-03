import type { TFunction } from 'i18next';
import { ApiError } from './api';

export interface ErrorText {
  title: string;
  description: string;
  /** The gateway's own explanation (English), when it is specific enough to help. */
  detail?: string | undefined;
  reference?: string | undefined;
}

type ErrorKey =
  | 'network'
  | 'denied'
  | 'notFound'
  | 'validation'
  | 'rateLimited'
  | 'planLimit'
  | 'unavailable'
  | 'idempotency'
  | 'conflict'
  | 'mfa'
  | 'tooLarge'
  | 'rejected'
  | 'disabled'
  | 'internal'
  | 'unknown';

function keyOf(error: ApiError): ErrorKey {
  switch (error.code) {
    case 'NETWORK':
      return 'network';
    case 'SCOPE_DENIED':
      return 'denied';
    case 'NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
      return 'validation';
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
      return 'rateLimited';
    case 'PLAN_LIMIT_REACHED':
      return 'planLimit';
    case 'PROVIDER_UNAVAILABLE':
    case 'AUTHORITY_UNAVAILABLE':
      return 'unavailable';
    case 'IDEMPOTENCY_CONFLICT':
      return 'idempotency';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'MFA_REQUIRED':
      return 'mfa';
    case 'UPLOAD_TOO_LARGE':
      return 'tooLarge';
    case 'UPLOAD_REJECTED':
      return 'rejected';
    case 'FEATURE_DISABLED':
      return 'disabled';
    case 'INTERNAL':
      return 'internal';
    default:
      return 'unknown';
  }
}

/** A specific, safe message for a failed request, with the reference people can quote. */
export function describeError(t: TFunction, error: unknown): ErrorText {
  if (!(error instanceof ApiError)) {
    return { title: t('errors.unknown.title'), description: t('errors.unknown.description') };
  }
  const key = keyOf(error);
  const detail =
    key === 'validation' ||
    key === 'denied' ||
    key === 'notFound' ||
    key === 'rejected' ||
    key === 'planLimit'
      ? error.problem?.detail
      : undefined;
  return {
    title: t(`errors.${key}.title`),
    description: t(`errors.${key}.description`),
    detail,
    reference: error.requestId ?? undefined,
  };
}
