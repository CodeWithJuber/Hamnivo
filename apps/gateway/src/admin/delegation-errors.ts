import type { DelegationProblem } from '@hamnivo/policy';
import { AppError } from '../common/app-error.js';

const DELEGATION_TEXT: Record<DelegationProblem['code'], string> = {
  not_allowed: "You can't grant access in this area.",
  self_grant: "You can't change your own access.",
  exceeds_own_permissions: 'You can only grant permissions you hold yourself.',
  outside_own_scope: 'You can only grant access inside the area you manage.',
  expiry_beyond_own: 'The access must expire no later than your own.',
};

const REVOCATION_TEXT: Record<DelegationProblem['code'], string> = {
  not_allowed: "You can't manage access in this area.",
  self_grant: "You can't change your own access.",
  exceeds_own_permissions:
    'This person has access you don’t hold yourself, so you can’t change it.',
  outside_own_scope: 'This person’s access reaches beyond the area you manage.',
  expiry_beyond_own: 'The access must expire no later than your own.',
};

/** The delegation ceiling (A03) as a public error, naming every rule that was broken. */
export function delegationError(problems: DelegationProblem[]): AppError {
  return new AppError('SCOPE_DENIED', {
    detail: [...new Set(problems.map((p) => DELEGATION_TEXT[p.code]))].join(' '),
    internal: problems,
  });
}

/** The same ceiling for taking access away or changing someone's access (A02). */
export function revocationError(problems: DelegationProblem[]): AppError {
  return new AppError('SCOPE_DENIED', {
    detail: [...new Set(problems.map((p) => REVOCATION_TEXT[p.code]))].join(' '),
    internal: problems,
  });
}
