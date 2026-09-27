import type { Decision, DenyReason } from './authorize.js';

/**
 * Stable message keys (translated in the Studio) and English defaults. The UI shows these next to
 * disabled actions so people know why and what would unblock them (HNV-24-02).
 */
export const DENY_MESSAGES: Record<DenyReason, { key: string; text: string; remedy: string }> = {
  inactive_principal: {
    key: 'policy.inactive',
    text: 'Your access is suspended.',
    remedy: 'Ask a workspace owner to restore your access.',
  },
  no_grant: {
    key: 'policy.no_grant',
    text: "Your role doesn't include this action.",
    remedy: 'Ask an administrator for a role that includes it.',
  },
  outside_scope: {
    key: 'policy.outside_scope',
    text: 'Your role applies to a different team, inbox or brand.',
    remedy: 'Ask an administrator to extend your access to this area.',
  },
  key_scope: {
    key: 'policy.key_scope',
    text: "This API key isn't allowed to do this.",
    remedy: 'Create a key with the needed scope.',
  },
  mfa_required: {
    key: 'policy.mfa_required',
    text: 'This action needs two-step verification.',
    remedy: 'Turn on two-step verification in your security settings, then sign in again.',
  },
  step_up_required: {
    key: 'policy.step_up_required',
    text: 'Please confirm it is you before continuing.',
    remedy: 'Re-enter your password or use your passkey.',
  },
};

export function explain(
  decision: Decision,
): { allowed: true } | { allowed: false; key: string; text: string; remedy: string } {
  if (decision.allowed) return { allowed: true };
  return { allowed: false, ...DENY_MESSAGES[decision.reason] };
}
