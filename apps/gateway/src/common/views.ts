import type { GrantScope } from '@hamnivo/contracts';
import { fromPublicId, toPublicId } from '@hamnivo/db';
import type { Scope } from '@hamnivo/policy';
import type { z } from 'zod';

type ContractScope = z.infer<typeof GrantScope>;

/** Database scope (UUIDs) → public scope (TypeIDs). */
export function scopeToContract(scope: Scope): ContractScope {
  if (scope.type === 'tenant') return { type: 'tenant' };
  return { type: scope.type, id: toPublicId(scope.type, scope.id) } as ContractScope;
}

/** Public scope (TypeIDs, already validated by the contract) → database scope. */
export function scopeFromContract(scope: ContractScope): Scope {
  if (scope.type === 'tenant') return { type: 'tenant' };
  return { type: scope.type, id: fromPublicId(scope.type, scope.id) };
}

export const iso = (date: Date | null | undefined): string | null =>
  date ? date.toISOString() : null;
