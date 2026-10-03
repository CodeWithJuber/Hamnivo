import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { CircleCheckIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { CopyButton } from '../../components/CopyButton';
import { TextField } from '../../components/Fields';
import { EMAIL } from '../../components/SignIn';
import { ActionError } from '../../components/States';
import { accessKeys, usePermissionCatalog, useRoles } from '../../lib/access';
import { useScopeNames } from '../../lib/access-text';
import { api, isApiError, newIdempotencyKey } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import type { CreatedInvitation, GrantScope } from '../../lib/types';
import {
  ExpiryField,
  endOfDay,
  RoleSelect,
  ScopeFields,
  type ScopeValue,
  TENANT_SCOPE,
  toGrantScope,
} from './AccessFields';

interface InviteBody {
  email: string;
  roleId: string;
  scope: GrantScope;
  grantExpiresAt: string | null;
}

/** Invite teammate (board 22): an address, a role and where it applies. */
export function InviteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const names = useScopeNames();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState<ScopeValue>(TENANT_SCOPE);
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [sent, setSent] = useState<CreatedInvitation | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setRoleId('');
    setScope(TENANT_SCOPE);
    setExpires('');
    setErrors({});
    setAttempted(false);
    setSent(null);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const invite = useStudioMutation(
    (body: InviteBody, tenant) =>
      api<CreatedInvitation>('/v1/admin/invitations', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      }),
    [accessKeys.invitations],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!EMAIL.test(email.trim())) next.email = t('access.inviteDialog.emailInvalid');
    if (!roleId) next.role = t('access.inviteDialog.pickRequired');
    const grantScope = toGrantScope(scope);
    if (!grantScope) next.scope = t('access.inviteDialog.pickRequired');
    setErrors(next);
    if (Object.keys(next).length > 0 || !grantScope) return;
    try {
      const created = await invite.mutateAsync({
        email: email.trim(),
        roleId,
        scope: grantScope,
        grantExpiresAt: expires ? endOfDay(expires) : null,
      });
      setSent(created);
      announce(t('access.inviteDialog.sent', { email: created.email }));
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          if (field.path === 'email') fields.email = field.message;
          if (field.path === 'scope') fields.scope = field.message;
        }
        if (Object.keys(fields).length > 0) setErrors(fields);
      }
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: field === 'scope' ? 'invite-scope-id' : `invite-${field}`,
        message,
      }))
    : [];
  const link = sent
    ? `${window.location.origin}/invitations/accept?token=${encodeURIComponent(sent.token)}`
    : '';

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!invite.isPending) onOpenChange(next);
      }}
      title={t('access.inviteDialog.title')}
      description={t('access.inviteDialog.description')}
      testId="invite-dialog"
    >
      {sent ? (
        <div className="flex flex-col gap-4">
          <p
            role="status"
            data-testid="invite-sent"
            className="flex items-start gap-3 rounded-lg border border-success/40 bg-success-subtle p-4 text-sm text-text"
          >
            <CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
            <span>{t('access.inviteDialog.sent', { email: sent.email })}</span>
          </p>
          <p className="text-sm text-text-secondary">{t('access.inviteDialog.linkHint')}</p>
          <code
            id="invite-link"
            dir="ltr"
            className="block break-all rounded-md border border-border bg-surface-muted p-3 text-xs"
          >
            {link}
          </code>
          <CopyButton
            text={link}
            label={t('access.inviteDialog.copyLink')}
            copiedLabel={t('app.copied')}
            failedLabel={t('access.copyFailed')}
            selectTarget={() => document.getElementById('invite-link')}
            testId="copy-invite-link"
          />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{t('access.inviteDialog.done')}</Button>
          </DialogFooter>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
          <TextField
            id="invite-email"
            type="email"
            label={t('access.inviteDialog.email')}
            value={email}
            dir="ltr"
            autoComplete="off"
            onChange={(event) => setEmail(event.target.value)}
            error={errors.email}
          />
          <RoleSelect
            id="invite-role"
            roles={roles.data?.items ?? []}
            catalog={catalog.data?.items ?? []}
            value={roleId}
            onChange={setRoleId}
            error={errors.role}
          />
          <ScopeFields
            idPrefix="invite"
            value={scope}
            onChange={setScope}
            names={names}
            error={errors.scope}
          />
          <ExpiryField id="invite-expires" value={expires} onChange={setExpires} />
          <ActionError error={isCancelled(invite.error) ? null : invite.error} />
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={invite.isPending}
            >
              {t('app.cancel')}
            </Button>
            <Button type="submit" busy={invite.isPending}>
              {t('access.inviteDialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </AppDialog>
  );
}
