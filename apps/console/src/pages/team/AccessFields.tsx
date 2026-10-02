import { useTranslation } from 'react-i18next';
import { type Option, SelectField, TextField } from '../../components/Fields';
import { roleWithinReach } from '../../lib/access';
import type { ScopeNames } from '../../lib/access-text';
import type { GrantScope, PermissionInfo, Role } from '../../lib/types';

export type ScopeType = 'tenant' | 'workspace' | 'team' | 'brand';

export interface ScopeValue {
  type: ScopeType;
  id: string;
}

export const TENANT_SCOPE: ScopeValue = { type: 'tenant', id: '' };

export function scopeValueOf(scope: GrantScope): ScopeValue {
  if (scope.type === 'tenant' || scope.type === 'inbox') return TENANT_SCOPE;
  return { type: scope.type, id: scope.id };
}

/** The request body form of a chosen scope, or null while a place still has to be picked. */
export function toGrantScope(value: ScopeValue): GrantScope | null {
  if (value.type === 'tenant') return { type: 'tenant' };
  return value.id ? ({ type: value.type, id: value.id } as GrantScope) : null;
}

/** A date field's day as the end of that day, in this browser's time zone. */
export function endOfDay(day: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function dayOf(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Roles to choose from; those reaching beyond the caller's own access are shown but disabled. */
export function RoleSelect({
  id,
  roles,
  catalog,
  value,
  onChange,
  error,
}: {
  id: string;
  roles: Role[];
  catalog: PermissionInfo[];
  value: string;
  onChange: (roleId: string) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const options: Option[] = roles.map((role) => {
    const reachable = roleWithinReach(role, catalog);
    return {
      value: role.id,
      label: reachable ? role.name : t('access.inviteDialog.roleBeyond', { name: role.name }),
      disabled: !reachable,
    };
  });
  return (
    <SelectField
      id={id}
      label={t('access.inviteDialog.role')}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      options={options}
      placeholder={t('access.inviteDialog.pick')}
      error={error}
    />
  );
}

/** Where a role applies: the whole workspace, or one workspace area, team or brand. */
export function ScopeFields({
  idPrefix,
  value,
  onChange,
  names,
  error,
}: {
  idPrefix: string;
  value: ScopeValue;
  onChange: (value: ScopeValue) => void;
  names: ScopeNames;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const targets: Record<Exclude<ScopeType, 'tenant'>, Option[]> = {
    workspace: names.workspaces.map((w) => ({ value: w.id, label: w.name })),
    team: names.teams.map((team) => ({ value: team.id, label: team.name })),
    brand: names.brands.map((b) => ({ value: b.id, label: b.name })),
  };
  const types: ScopeType[] = ['tenant', 'workspace', 'team', 'brand'];
  return (
    <div className="flex flex-col gap-4">
      <SelectField
        id={`${idPrefix}-scope-type`}
        label={t('access.inviteDialog.where')}
        value={value.type}
        onChange={(event) => onChange({ type: event.target.value as ScopeType, id: '' })}
        options={types
          .filter((type) => type === 'tenant' || targets[type].length > 0)
          .map((type) => ({ value: type, label: t(`access.scopeTypes.${type}`) }))}
      />
      {value.type === 'tenant' ? null : (
        <SelectField
          id={`${idPrefix}-scope-id`}
          label={t(`access.inviteDialog.${value.type}`)}
          value={value.id}
          onChange={(event) => onChange({ type: value.type, id: event.target.value })}
          options={targets[value.type]}
          placeholder={t('access.inviteDialog.pick')}
          error={error}
        />
      )}
    </div>
  );
}

/** The optional end of the access, as a date. */
export function ExpiryField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (day: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <TextField
      id={id}
      type="date"
      label={t('access.inviteDialog.expires')}
      labelNote={t('app.optional')}
      hint={t('access.inviteDialog.expiresHint')}
      value={value}
      min={dayOf(new Date().toISOString())}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
