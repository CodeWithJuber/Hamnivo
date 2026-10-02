import { Button } from '@hamnivo/ui/components/button';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CircleCheckIcon, LockIcon, PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QueryState } from '../../components/States';
import { expandPatterns, usePermissionCatalog, useRoles } from '../../lib/access';
import { useTenant } from '../../lib/tenant';
import type { Role } from '../../lib/types';
import { RoleEditor } from './RoleEditor';

/** Built-in and custom roles, and the editor for custom roles (A12, board 22). */
export function RolesTab() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const search = useSearch({ from: '/_studio/team' });
  const navigate = useNavigate({ from: '/team' });
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const [seed, setSeed] = useState<{ name: string; permissions: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (roleId: string | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, tab: 'roles', role: roleId }) });
  const keys = (catalog.data?.items ?? []).map((p) => p.key);
  const selected =
    search.role && search.role !== 'new'
      ? (roles.data?.items.find((r) => r.id === search.role) ?? null)
      : null;
  const editorOpen =
    catalog.data !== undefined && (search.role === 'new' ? can('roles.manage') : selected !== null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-text-secondary">{t('access.roles.intro')}</p>
        {can('roles.manage') ? (
          <Button
            onClick={() => {
              setSeed(null);
              setNotice(null);
              open('new');
            }}
            data-testid="new-role"
          >
            <PlusIcon aria-hidden="true" />
            {t('access.roles.new')}
          </Button>
        ) : null}
      </div>
      {notice ? (
        <p
          role="status"
          data-testid="roles-notice"
          className="flex items-start gap-3 rounded-lg border border-success/40 bg-success-subtle p-3 text-sm text-text"
        >
          <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
          <span className="flex-1">{notice}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('app.close')}
            onClick={() => setNotice(null)}
          >
            <XIcon aria-hidden="true" />
          </Button>
        </p>
      ) : null}
      <QueryState query={roles} label={t('access.roles.loading')}>
        {(data) => (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="roles-list">
            {data.items.map((role: Role) => (
              <li
                key={role.id}
                data-role={role.key}
                className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h3 className="font-semibold text-text">
                      <bdi>{role.name}</bdi>
                    </h3>
                    {role.description ? (
                      <p className="text-sm text-text-secondary">{role.description}</p>
                    ) : null}
                  </div>
                  <StatusBadge tone={role.isPreset ? 'neutral' : 'info'} icon={null}>
                    {role.isPreset ? t('access.roles.builtIn') : t('access.roles.custom')}
                  </StatusBadge>
                </div>
                <p className="text-sm text-text-secondary">
                  {t('access.roles.permissions', {
                    n: expandPatterns(role.permissions, keys).length,
                  })}
                  {' · '}
                  {t('access.roles.members', { n: role.memberCount })}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setNotice(null);
                      open(role.id);
                    }}
                    aria-label={t('access.roles.open', { name: role.name })}
                  >
                    {t('access.roles.open', { name: role.name })}
                  </Button>
                  {role.isPreset || !role.editable ? (
                    <span className="flex items-center gap-1 text-xs text-text-secondary">
                      <LockIcon className="size-3.5" aria-hidden="true" />
                      {t('access.roles.readOnly')}
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {editorOpen && catalog.data ? (
        <RoleEditor
          key={search.role}
          role={selected}
          seed={search.role === 'new' ? seed : null}
          catalog={catalog.data.items}
          onClose={() => open(undefined)}
          onDuplicate={(role) => {
            setSeed({
              name: t('access.roles.copyName', { name: role.name }),
              permissions: role.permissions,
            });
            open('new');
          }}
          onSaved={(message) => {
            setNotice(message);
            open(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
