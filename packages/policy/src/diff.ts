import { expandPatterns, PERMISSIONS, type Permission } from './catalog.js';

export interface PermissionDiff {
  added: Permission[];
  removed: Permission[];
  /** Added permissions that need MFA or a fresh session: highlighted for reviewers. */
  addedSensitive: Permission[];
}

/** What changes when a role's permissions go from `before` to `after` (audit + review UI). */
export function diffPermissions(
  before: readonly string[],
  after: readonly string[],
): PermissionDiff {
  const a = new Set(expandPatterns(before));
  const b = new Set(expandPatterns(after));
  const added = [...b].filter((p) => !a.has(p));
  const removed = [...a].filter((p) => !b.has(p));
  const addedSensitive = added.filter((p) => {
    const spec = PERMISSIONS[p];
    return ('mfa' in spec && spec.mfa) || ('stepUp' in spec && spec.stepUp);
  });
  return { added, removed, addedSensitive };
}
