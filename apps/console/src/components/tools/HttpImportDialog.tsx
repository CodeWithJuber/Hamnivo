import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toolKeys } from '../../lib/actions';
import { HTTP_SPEC_MAX_CHARS, type HttpSpecPreview, type HttpToolSource } from '../../lib/ai-power';
import { api, newIdempotencyKey } from '../../lib/api';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { AppDialog, DialogFooter } from '../AppDialog';
import { CheckboxField, ChoiceField, SelectField, TextareaField, TextField } from '../Fields';
import { ActionError } from '../States';
import {
  type AuthDraft,
  addressError,
  authBody,
  authErrors,
  emptyAuth,
  isolate,
  RequestLine,
  refusedPaths,
  ServiceFields,
} from './HttpToolForms';

/** The most requests one import takes (the gateway's limit). */
const MOST = 100;

/**
 * What the description says about how the service signs in, as what a person would type: a bearer
 * token or a secret in a named header. Anything else starts as no credential.
 */
function authFrom(preview: HttpSpecPreview): AuthDraft {
  const base = emptyAuth();
  if (preview.auth.kind === 'bearer') return { ...base, kind: 'bearer' };
  if (preview.auth.kind === 'header') {
    return { ...base, kind: 'header', header: preview.auth.header ?? base.header };
  }
  return base;
}

/**
 * Import an OpenAPI description: read it, then choose which of its requests become tools. Used to
 * add a new service, or (with `source`) to add the requests it does not have yet to a service that
 * is there. Nothing is saved until the requests are chosen; what the description says about each
 * one is shown as quoted text, and the tools wait for review.
 */
export function HttpImportDialog({
  open,
  onOpenChange,
  brandId,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  brandId: string;
  /** Adding to this service; a new service when absent. */
  source?: HttpToolSource | undefined;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [via, setVia] = useState<'paste' | 'address'>('paste');
  const [text, setText] = useState('');
  const [address, setAddress] = useState('');
  const [preview, setPreview] = useState<HttpSpecPreview | null>(null);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [auth, setAuth] = useState<AuthDraft>(emptyAuth);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  useEffect(() => {
    if (!open) return;
    setVia('paste');
    setText('');
    setAddress('');
    setPreview(null);
    setName('');
    setBaseUrl('');
    setAuth(emptyAuth());
    setChosen(new Set());
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const read = useStudioMutation(
    (body: Record<string, string>, tenant) =>
      api<HttpSpecPreview>('/v1/admin/http-tools/preview', { method: 'POST', body, tenant }),
    [],
  );
  const add = useStudioMutation(
    (body: Record<string, unknown>, tenant) =>
      source
        ? api<HttpToolSource>(`/v1/admin/http-tools/sources/${source.id}/endpoints`, {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          })
        : api<HttpToolSource>('/v1/admin/http-tools/sources', {
            method: 'POST',
            body,
            tenant,
            idempotencyKey,
          }),
    [toolKeys.tools],
  );

  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    const content = await file.text();
    if (content.length > HTTP_SPEC_MAX_CHARS) {
      setErrors({ 'import-text': t('aiPower.http.importDialog.fileTooBig') });
      return;
    }
    setErrors({});
    setText(content);
  };

  const readIt = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const found: Record<string, string> = {};
    if (via === 'paste' && text.trim().length < 2) {
      found['import-text'] = t('aiPower.http.importDialog.needText');
    }
    if (via === 'address' && !/^https?:\/\/\S+$/i.test(address.trim())) {
      found['import-address'] = t('aiPower.http.importDialog.needUrl');
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    try {
      const result = await read.mutateAsync({
        ...(via === 'paste' ? { spec: text } : { specUrl: address.trim() }),
        ...(source ? { sourceId: source.id } : {}),
      });
      setPreview(result);
      setName(result.title ?? '');
      setBaseUrl(result.servers[0] ?? '');
      setAuth(authFrom(result));
      // The requests that only read are the safe ones to start from; a change is for the person to choose.
      setChosen(
        new Set(
          result.operations
            .filter((op) => op.risk === 'read' && !op.imported)
            .slice(0, MOST)
            .map((op) => op.key),
        ),
      );
      setAttempted(false);
      setErrors({});
    } catch (error) {
      const refusal = refusedPaths(error);
      const message = refusal.spec ?? refusal.specUrl;
      if (message) setErrors({ [via === 'paste' ? 'import-text' : 'import-address']: message });
    }
  };

  const toggle = (key: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!preview) return;
    setAttempted(true);
    const found: Record<string, string> = {};
    if (!source) {
      if (!name.trim()) found['svc-name'] = t('aiPower.http.service.errors.name');
      Object.assign(found, addressError(baseUrl, 'svc', t), authErrors(auth, 'svc-auth', t));
    }
    if (chosen.size === 0) found['import-operations'] = t('aiPower.http.importDialog.needOne');
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const openapi = {
      ...(via === 'paste' ? { spec: text } : { specUrl: address.trim(), specHash: preview.hash }),
      operations: preview.operations.filter((op) => chosen.has(op.key)).map((op) => op.key),
    };
    try {
      await add.mutateAsync(
        source
          ? { openapi }
          : { brandId, name: name.trim(), baseUrl: baseUrl.trim(), auth: authBody(auth), openapi },
      );
      announce(t('aiPower.http.importDialog.added', { count: openapi.operations.length }));
      onOpenChange(false);
    } catch (error) {
      const refusal = refusedPaths(error);
      const fields: Record<string, string> = {};
      if (refusal.name) fields['svc-name'] = refusal.name;
      if (refusal.baseUrl) fields['svc-baseUrl'] = refusal.baseUrl;
      if (refusal.auth) fields['svc-auth-auth'] = refusal.auth;
      const operations = refusal['openapi.operations'];
      if (operations) fields['import-operations'] = operations;
      if (Object.keys(fields).length > 0) setErrors(fields);
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  const failed = preview ? add.error : read.error;
  const refused = Object.keys(refusedPaths(failed)).length > 0;
  const busy = read.isPending || add.isPending;

  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={
        source
          ? t('aiPower.http.importDialog.titleMore', { name: source.name })
          : t('aiPower.http.importDialog.title')
      }
      description={t('aiPower.http.importDialog.description')}
      testId="http-import-dialog"
      className="sm:max-w-3xl"
    >
      {!preview ? (
        <form className="flex flex-col gap-5" onSubmit={readIt} noValidate>
          <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
          <ChoiceField
            id="import-via"
            legend={t('aiPower.http.importDialog.where')}
            value={via}
            onValueChange={(value) => {
              setVia(value as 'paste' | 'address');
              setErrors({});
            }}
            choices={[
              { value: 'paste', label: t('aiPower.http.importDialog.paste') },
              { value: 'address', label: t('aiPower.http.importDialog.address') },
            ]}
          />
          {via === 'paste' ? (
            <>
              <TextareaField
                id="import-text"
                label={t('aiPower.http.importDialog.text')}
                hint={t('aiPower.http.importDialog.textHint')}
                value={text}
                rows={8}
                dir="ltr"
                spellCheck={false}
                className="font-mono text-xs"
                onChange={(event) => setText(event.target.value)}
                error={errors['import-text']}
              />
              <TextField
                id="import-file"
                type="file"
                accept=".json,.yaml,.yml,application/json,text/yaml,text/plain"
                label={t('aiPower.http.importDialog.file')}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
            </>
          ) : (
            <TextField
              id="import-address"
              label={t('aiPower.http.importDialog.specUrl')}
              hint={t('aiPower.http.importDialog.specUrlHint')}
              type="url"
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.example.com/openapi.json"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              error={errors['import-address']}
            />
          )}
          <ActionError error={isCancelled(read.error) || refused ? null : read.error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t('app.cancel')}
            </Button>
            <Button type="submit" busy={read.isPending} data-testid="read-spec">
              {t('aiPower.http.importDialog.read')}
            </Button>
          </DialogFooter>
        </form>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
          <p className="text-sm text-text" data-testid="import-found">
            {preview.title
              ? t('aiPower.http.importDialog.found', {
                  title: isolate(preview.title),
                  version: isolate(preview.version ?? ''),
                  count: preview.operations.length,
                })
              : t('aiPower.http.importDialog.foundUntitled', { count: preview.operations.length })}
          </p>
          {preview.operations.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('aiPower.http.importDialog.none')}</p>
          ) : null}
          {source ? null : (
            <>
              {preview.servers.length > 1 ? (
                <SelectField
                  id="import-servers"
                  label={t('aiPower.http.importDialog.servers')}
                  hint={t('aiPower.http.importDialog.serversHint')}
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  options={preview.servers.map((server) => ({ value: server, label: server }))}
                />
              ) : null}
              {preview.auth.unsupported ? (
                <p
                  className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
                  data-testid="import-auth-unsupported"
                >
                  {t('aiPower.http.importDialog.authUnsupported', {
                    kind: preview.auth.unsupported,
                  })}
                </p>
              ) : null}
              <ServiceFields
                id="svc"
                name={name}
                baseUrl={baseUrl}
                auth={auth}
                onName={setName}
                onBaseUrl={setBaseUrl}
                onAuth={setAuth}
                errors={errors}
              />
            </>
          )}

          {preview.operations.length > 0 ? (
            <fieldset
              className="flex flex-col gap-3"
              aria-describedby="import-operations-hint"
              data-testid="import-operations"
            >
              <legend className="text-sm font-semibold text-text">
                {t('aiPower.http.importDialog.operations')}
              </legend>
              <p id="import-operations-hint" className="text-sm text-text-secondary">
                {t('aiPower.http.importDialog.operationsHint')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setChosen(
                      new Set(
                        preview.operations
                          .filter((op) => op.risk === 'read' && !op.imported)
                          .slice(0, MOST)
                          .map((op) => op.key),
                      ),
                    )
                  }
                >
                  {t('aiPower.http.importDialog.selectReads')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setChosen(
                      new Set(
                        preview.operations
                          .filter((op) => !op.imported)
                          .slice(0, MOST)
                          .map((op) => op.key),
                      ),
                    )
                  }
                >
                  {t('aiPower.http.importDialog.selectAll')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setChosen(new Set())}
                >
                  {t('aiPower.http.importDialog.selectNone')}
                </Button>
                <span className="text-sm text-text-secondary" aria-live="polite">
                  {t('aiPower.http.importDialog.chosen', { count: chosen.size })}
                </span>
              </div>
              {errors['import-operations'] ? (
                <p role="alert" id="import-operations" className="text-sm font-medium text-danger">
                  {errors['import-operations']}
                </p>
              ) : null}
              <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto rounded-lg border border-border p-2">
                {preview.operations.map((op, index) => (
                  <li
                    key={op.key}
                    className="flex flex-col gap-1 rounded-lg border border-border p-2"
                    data-operation={op.key}
                  >
                    <CheckboxField
                      id={`import-op-${index}`}
                      checked={chosen.has(op.key) && !op.imported}
                      disabled={op.imported}
                      onCheckedChange={(on) => toggle(op.key, on)}
                      label={
                        <span className="flex flex-col gap-1">
                          <RequestLine method={op.method} path={op.path} />
                          <span className="font-medium text-text">
                            <bdi>{op.title}</bdi>
                          </span>
                        </span>
                      }
                      hint={
                        <span className="flex flex-col gap-1">
                          <span>
                            {t(`tools.risk.${op.risk}`)}
                            {op.imported ? ` · ${t('aiPower.http.importDialog.already')}` : ''}
                          </span>
                          {op.summary ? (
                            <span className="line-clamp-2 text-xs">
                              <bdi>{op.summary}</bdi>
                            </span>
                          ) : null}
                          {op.notes.length > 0 ? (
                            <span className="text-xs">
                              {t('aiPower.http.importDialog.left')} <bdi>{op.notes.join(' ')}</bdi>
                            </span>
                          ) : null}
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}

          {preview.skipped.length > 0 ? (
            <details className="text-sm" data-testid="import-skipped">
              <summary className="cursor-pointer font-medium text-text">
                {t('aiPower.http.importDialog.skipped', { count: preview.skipped.length })}
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {preview.skipped.map((skipped) => (
                  <li key={skipped.key} className="text-text-secondary">
                    <StatusBadge tone="neutral" icon={null} className="font-mono" dir="ltr">
                      {skipped.key}
                    </StatusBadge>{' '}
                    <bdi>{skipped.reason}</bdi>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          <ActionError error={isCancelled(add.error) || refused ? null : add.error} />
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setPreview(null);
                setErrors({});
                setAttempted(false);
              }}
            >
              {t('aiPower.http.importDialog.readAgain')}
            </Button>
            <Button
              type="submit"
              busy={add.isPending}
              disabled={preview.operations.length === 0}
              data-testid="add-chosen"
            >
              {t('aiPower.http.importDialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      )}
    </AppDialog>
  );
}
