import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { PlusIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, ConfirmDialog, DialogFooter } from '../../components/AppDialog';
import { TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { accessKeys, usePermissionCatalog, useRoles } from '../../lib/access';
import { scopeLabel, useScopeNames } from '../../lib/access-text';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import type { GrantScope, GrantView, Member } from '../../lib/types';
import {
  dayOf,
  ExpiryField,
  endOfDay,
  RoleSelect,
  ScopeFields,
  type ScopeValue,
  scopeValueOf,
  TENANT_SCOPE,
  toGrantScope,
} from './AccessFields';

interface GrantBody {
  roleId: string;
  scope: GrantScope;
  expiresAt: string | null;
  reason?: string;
}

type Mode = { kind: 'list' } | { kind: 'edit'; grant: GrantView } | { kind: 'add' };

/**
 * A member's roles and where they apply (A02): change one in a single step, remove one, or add
 * another. Every change stays within the caller's own access; the gateway checks again.
 */
export function AccessDialog({
  member,
  onOpenChange,
}: {
  member: Member;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const names = useScopeNames();
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState<ScopeValue>(TENANT_SCOPE);
  const [expires, setExpires] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<GrantView | null>(null);

  useEffect(() => {
    if (mode.kind === 'edit') {
      setRoleId(mode.grant.role.id);
      setScope(scopeValueOf(mode.grant.scope));
      setExpires(dayOf(mode.grant.expiresAt));
    } else {
      setRoleId('');
      setScope(TENANT_SCOPE);
      setExpires('');
    }
    setReason('');
    setErrors({});
  }, [mode]);

  const invalidate = [accessKeys.members, accessKeys.roles, accessKeys.audit];
  const replace = useStudioMutation(
    ({ grantId, body }: { grantId: string; body: GrantBody }, tenant) =>
      api<GrantView>(`/v1/admin/grants/${grantId}/replace`, { method: 'POST', body, tenant }),
    invalidate,
  );
  const add = useStudioMutation(
    (body: GrantBody, tenant) =>
      api<GrantView>('/v1/admin/grants', {
        method: 'POST',
        body: { ...body, staffMemberId: member.id },
        tenant,
      }),
    invalidate,
  );
  const revoke = useStudioMutation(
    (grantId: string, tenant) =>
      api<void>(`/v1/admin/grants/${grantId}/revoke`, { method: 'POST', body: {}, tenant }),
    invalidate,
  );
  const pending = replace.isPending || add.isPending;
  const failure = mode.kind === 'edit' ? replace.error : add.error;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!roleId) next.role = t('access.inviteDialog.pickRequired');
    const grantScope = toGrantScope(scope);
    if (!grantScope) next.scope = t('access.inviteDialog.pickRequired');
    setErrors(next);
    if (Object.keys(next).length > 0 || !grantScope) return;
    const body: GrantBody = {
      roleId,
      scope: grantScope,
      expiresAt: expires ? endOfDay(expires) : null,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    };
    try {
      if (mode.kind === 'edit') await replace.mutateAsync({ grantId: mode.grant.id, body });
      else await add.mutateAsync(body);
      announce(t('access.changeDialog.saved', { name: member.displayName }));
      setMode({ kind: 'list' });
    } catch {
      // Shown below the form.
    }
  };

  const editing = mode.kind !== 'list';
  const title =
    mode.kind === 'edit'
      ? t('access.changeDialog.editTitle', { role: mode.grant.role.name })
      : mode.kind === 'add'
        ? t('access.changeDialog.addTitle')
        : t('access.changeDialog.title', { name: member.displayName });

  return (
    <>
      <AppDialog
        open
        onOpenChange={(open) => {
          if (!pending) onOpenChange(open);
        }}
        title={title}
        description={editing ? undefined : t('access.changeDialog.description')}
        testId="access-dialog"
      >
        {editing ? (
          <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
            <FormErrorSummary
              title={t('auth.errorSummary')}
              errors={Object.entries(errors).map(([field, message]) => ({
                fieldId: field === 'scope' ? 'access-scope-id' : `access-${field}`,
                message,
              }))}
            />
            <RoleSelect
              id="access-role"
              roles={roles.data?.items ?? []}
              catalog={catalog.data?.items ?? []}
              value={roleId}
              onChange={setRoleId}
              error={errors.role}
            />
            <ScopeFields
              idPrefix="access"
              value={scope}
              onChange={setScope}
              names={names}
              error={errors.scope}
            />
            <ExpiryField id="access-expires" value={expires} onChange={setExpires} />
            <TextField
              id="access-reason"
              label={t('access.changeDialog.reason')}
              labelNote={t('app.optional')}
              hint={t('access.changeDialog.reasonHint')}
              value={reason}
              maxLength={400}
              onChange={(event) => setReason(event.target.value)}
            />
            <ActionError error={isCancelled(failure) ? null : failure} />
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                disabled={pending}
                onClick={() => setMode({ kind: 'list' })}
              >
                {t('access.changeDialog.back')}
              </Button>
              <Button type="submit" busy={pending}>
                {t('access.changeDialog.save')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-text">{t('access.changeDialog.current')}</h3>
            {member.grants.length === 0 ? (
              <p className="text-sm text-text-secondary">{t('access.changeDialog.none')}</p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="member-grants">
                {member.grants.map((grant) => (
                  <li
                    key={grant.id}
                    data-grant={grant.role.key}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                  >
                    <span className="flex min-w-0 flex-col text-sm">
                      <span className="font-medium text-text">
                        <bdi>{grant.role.name}</bdi>
                      </span>
                      <span className="text-text-secondary">
                        {scopeLabel(t, grant.scope, names)}
                        {grant.expiresAt
                          ? ` · ${t('access.team.until', { time: formatDateTime(grant.expiresAt) })}`
                          : ''}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setMode({ kind: 'edit', grant })}
                      >
                        {t('access.changeDialog.change')}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        aria-label={t('access.changeDialog.removeRoleLabel', {
                          role: grant.role.name,
                          name: member.displayName,
                        })}
                        onClick={() => setRemoving(grant)}
                      >
                        {t('access.changeDialog.removeRole')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => setMode({ kind: 'add' })}
            >
              <PlusIcon aria-hidden="true" />
              {t('access.changeDialog.add')}
            </Button>
          </div>
        )}
      </AppDialog>
      {removing ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={t('access.changeDialog.removeRoleTitle', {
            role: removing.role.name,
            name: member.displayName,
          })}
          confirmLabel={t('access.changeDialog.removeRole')}
          variant="destructive-solid"
          onConfirm={async () => {
            await revoke.mutateAsync(removing.id);
            announce(t('access.changeDialog.saved', { name: member.displayName }));
          }}
        >
          <p>{t('access.changeDialog.removeRoleBody')}</p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
