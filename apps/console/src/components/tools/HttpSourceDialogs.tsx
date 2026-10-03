import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toolKeys } from '../../lib/actions';
import type { HttpToolSource } from '../../lib/ai-power';
import { api } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { AppDialog, ConfirmDialog, DialogFooter } from '../AppDialog';
import { ChoiceField, TextField } from '../Fields';
import { ActionError } from '../States';
import {
  type AuthDraft,
  AuthFields,
  addressError,
  authBody,
  authErrors,
  emptyAuth,
  refusedPaths,
} from './HttpToolForms';

type CredentialChange = 'keep' | 'replace' | 'remove';

/** Edits a service's name and address, and keeps, replaces or removes its credential. */
export function EditHttpSourceDialog({
  source,
  open,
  onOpenChange,
}: {
  source: HttpToolSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [name, setName] = useState(source.name);
  const [baseUrl, setBaseUrl] = useState(source.baseUrl);
  const [change, setChange] = useState<CredentialChange>('keep');
  const [auth, setAuth] = useState<AuthDraft>(emptyAuth);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const hasCredential = source.auth.kind !== 'none';

  useEffect(() => {
    if (!open) return;
    setName(source.name);
    setBaseUrl(source.baseUrl);
    setChange('keep');
    setAuth({ ...emptyAuth(), kind: source.auth.kind === 'none' ? 'none' : 'bearer' });
    setErrors({});
    setAttempted(false);
  }, [open, source.name, source.baseUrl, source.auth.kind]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      api<HttpToolSource>(`/v1/admin/http-tools/sources/${source.id}`, {
        method: 'PATCH',
        body,
        tenant,
      }),
    [toolKeys.tools],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const found: Record<string, string> = {};
    if (!name.trim()) found['edit-svc-name'] = t('aiPower.http.service.errors.name');
    Object.assign(found, addressError(baseUrl, 'edit-svc', t));
    const sending = hasCredential ? change === 'replace' : auth.kind !== 'none';
    if (sending) Object.assign(found, authErrors(auth, 'edit-svc-auth', t));
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const body: Record<string, unknown> = {};
    if (name.trim() !== source.name) body.name = name.trim();
    if (baseUrl.trim() !== source.baseUrl) body.baseUrl = baseUrl.trim();
    if (sending) body.auth = authBody(auth);
    else if (hasCredential && change === 'remove') body.auth = { kind: 'none' };
    if (Object.keys(body).length === 0) {
      announce(t('aiPower.http.editDialog.nothing'));
      onOpenChange(false);
      return;
    }
    try {
      const saved = await save.mutateAsync(body);
      announce(t('aiPower.http.editDialog.saved', { name: saved.name }));
      onOpenChange(false);
    } catch (error) {
      const refusal = refusedPaths(error);
      const fields: Record<string, string> = {};
      if (refusal.name) fields['edit-svc-name'] = refusal.name;
      if (refusal.baseUrl) fields['edit-svc-baseUrl'] = refusal.baseUrl;
      if (refusal.auth) fields['edit-svc-auth-auth'] = refusal.auth;
      if (Object.keys(fields).length > 0) setErrors(fields);
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  const refused = Object.keys(refusedPaths(save.error)).length > 0;
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) onOpenChange(next);
      }}
      title={t('aiPower.http.editDialog.title', { name: source.name })}
      description={t('aiPower.http.editDialog.description')}
      testId="edit-http-source-dialog"
    >
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <TextField
          id="edit-svc-name"
          label={t('aiPower.http.editDialog.name')}
          value={name}
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
          error={errors['edit-svc-name']}
        />
        <TextField
          id="edit-svc-baseUrl"
          label={t('aiPower.http.editDialog.baseUrl')}
          hint={
            baseUrl.trim() !== source.baseUrl
              ? t('aiPower.http.editDialog.baseUrlWarning')
              : t('aiPower.http.service.baseUrlHint')
          }
          value={baseUrl}
          dir="ltr"
          type="url"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setBaseUrl(event.target.value)}
          error={errors['edit-svc-baseUrl']}
        />
        {hasCredential ? (
          <ChoiceField
            id="edit-credential"
            legend={t('aiPower.http.editDialog.credential')}
            hint={
              <bdi dir="ltr" className="font-mono text-xs">
                {source.auth.masked}
              </bdi>
            }
            value={change}
            onValueChange={(value) => setChange(value as CredentialChange)}
            choices={(['keep', 'replace', 'remove'] as const).map((choice) => ({
              value: choice,
              label: t(`aiPower.http.editDialog.${choice}`),
            }))}
          />
        ) : null}
        {!hasCredential || change === 'replace' ? (
          <AuthFields
            id="edit-svc-auth"
            auth={auth}
            onChange={setAuth}
            errors={errors}
            kinds={hasCredential ? ['bearer', 'header'] : ['none', 'bearer', 'header']}
          />
        ) : null}
        <ActionError error={isCancelled(save.error) || refused ? null : save.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending} data-testid="save-http-source">
            {t('aiPower.http.editDialog.save')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}

/** Asks before a service is removed: its tools go, its credential is deleted. */
export function RemoveHttpSourceDialog({
  source,
  open,
  onOpenChange,
}: {
  source: HttpToolSource;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const remove = useStudioMutation(
    (_: undefined, tenant) =>
      api<undefined>(`/v1/admin/http-tools/sources/${source.id}`, { method: 'DELETE', tenant }),
    [toolKeys.tools],
  );
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('aiPower.http.removeDialog.title', { name: source.name })}
      confirmLabel={t('aiPower.http.removeDialog.confirm')}
      variant="destructive-solid"
      testId="remove-http-source-dialog"
      onConfirm={async () => {
        await remove.mutateAsync(undefined);
        announce(t('aiPower.http.removeDialog.done', { name: source.name }));
      }}
    >
      <p>{t('aiPower.http.removeDialog.body')}</p>
    </ConfirmDialog>
  );
}
