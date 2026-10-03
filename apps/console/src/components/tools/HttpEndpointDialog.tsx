import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type RiskClass, toolKeys } from '../../lib/actions';
import type {
  HttpToolArgumentIn,
  HttpToolEndpoint,
  HttpToolMethod,
  HttpToolSource,
} from '../../lib/ai-power';
import { api, newIdempotencyKey } from '../../lib/api';
import {
  type ArgumentDraft,
  blankDraft,
  draftErrors,
  draftOf,
  type EndpointDraft,
  endpointBody,
  MOST_DETAILS,
  missingPlaceholders,
  newArgument,
  pathArgument,
  VALUE_TYPES,
  type ValueType,
} from '../../lib/http-tools';
import { useStudioMutation } from '../../lib/queries';
import { isCancelled } from '../../lib/reauth';
import { AppDialog, DialogFooter } from '../AppDialog';
import { CheckboxField, SelectField, TextareaField, TextField } from '../Fields';
import { ActionError } from '../States';
import {
  type AuthDraft,
  addressError,
  authBody,
  authErrors,
  emptyAuth,
  refusedPaths,
  ServiceFields,
} from './HttpToolForms';

/** What the dialog is for: a new service with its first request, another request, or a change. */
export type EndpointMode =
  | { kind: 'create'; brandId: string }
  | { kind: 'add'; source: HttpToolSource }
  | { kind: 'edit'; source: HttpToolSource; endpoint: HttpToolEndpoint };

const METHODS: HttpToolMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const PLACES: HttpToolArgumentIn[] = ['path', 'query', 'header', 'body'];
const RISKS: RiskClass[] = ['read', 'write', 'money', 'irreversible'];

/**
 * A request written by hand: its method and path, what the AI is told it does, and the details the
 * AI fills in, each going to one place in the request. It adds a service with this one request, adds
 * a request to a service, or changes a request written by hand (which sends it back to review).
 */
export function HttpEndpointDialog({
  mode,
  onOpenChange,
}: {
  mode: EndpointMode | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [auth, setAuth] = useState<AuthDraft>(emptyAuth);
  const [draft, setDraft] = useState<EndpointDraft>(blankDraft);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);

  // The form starts over when the dialog opens for something else, not each time the page behind
  // it draws again (a new `mode` object comes with every draw).
  const identity =
    mode === null
      ? null
      : mode.kind === 'edit'
        ? `edit:${mode.endpoint.toolId}:${mode.endpoint.revision}`
        : mode.kind === 'add'
          ? `add:${mode.source.id}`
          : `create:${mode.brandId}`;
  const latest = useRef(mode);
  latest.current = mode;

  // Starts from what the request is now (a change), or from nothing (a new one).
  useEffect(() => {
    const current = latest.current;
    if (identity === null || current === null) return;
    setName('');
    setBaseUrl('');
    setAuth(emptyAuth());
    setDraft(current.kind === 'edit' ? draftOf(current.endpoint) : blankDraft());
    setErrors({});
    setAttempted(false);
    setIdempotencyKey(newIdempotencyKey());
  }, [identity]);

  const save = useStudioMutation(
    (body: Record<string, unknown>, tenant) => {
      if (mode?.kind === 'edit') {
        return api<HttpToolSource>(
          `/v1/admin/http-tools/sources/${mode.source.id}/endpoints/${mode.endpoint.toolId}`,
          { method: 'PUT', body, tenant },
        );
      }
      if (mode?.kind === 'add') {
        return api<HttpToolSource>(`/v1/admin/http-tools/sources/${mode.source.id}/endpoints`, {
          method: 'POST',
          body,
          tenant,
          idempotencyKey,
        });
      }
      return api<HttpToolSource>('/v1/admin/http-tools/sources', {
        method: 'POST',
        body,
        tenant,
        idempotencyKey,
      });
    },
    [toolKeys.tools],
  );

  const patch = (changes: Partial<EndpointDraft>) => setDraft((d) => ({ ...d, ...changes }));
  const changeArg = (uid: number, changes: Partial<ArgumentDraft>) =>
    setDraft((d) => ({
      ...d,
      args: d.args.map((a) => (a.uid === uid ? { ...a, ...changes } : a)),
    }));
  const addArg = (arg: ArgumentDraft) => setDraft((d) => ({ ...d, args: [...d.args, arg] }));
  const missing = missingPlaceholders(draft);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!mode) return;
    setAttempted(true);
    const found = draftErrors(draft, t);
    if (mode.kind === 'create') {
      if (!name.trim()) found['svc-name'] = t('aiPower.http.service.errors.name');
      Object.assign(found, addressError(baseUrl, 'svc', t), authErrors(auth, 'svc-auth', t));
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const endpoint = endpointBody(draft);
    const body =
      mode.kind === 'edit'
        ? { ...endpoint, expectedRevision: mode.endpoint.revision }
        : mode.kind === 'add'
          ? { endpoint }
          : {
              brandId: mode.brandId,
              name: name.trim(),
              baseUrl: baseUrl.trim(),
              auth: authBody(auth),
              endpoint,
            };
    try {
      await save.mutateAsync(body);
      announce(
        t(
          mode.kind === 'edit'
            ? 'aiPower.http.endpointDialog.saved'
            : 'aiPower.http.endpointDialog.added',
          { name: draft.title.trim() },
        ),
      );
      onOpenChange(false);
    } catch (error) {
      const refusal = refusedPaths(error);
      const fields: Record<string, string> = {};
      if (refusal.name) fields['svc-name'] = refusal.name;
      if (refusal.baseUrl) fields['svc-baseUrl'] = refusal.baseUrl;
      if (refusal.auth) fields['svc-auth-auth'] = refusal.auth;
      if (refusal.title) fields['ep-title'] = refusal.title;
      if (refusal.description) fields['ep-about'] = refusal.description;
      if (refusal.path) fields['ep-path'] = refusal.path;
      if (refusal.arguments) fields['ep-arguments'] = refusal.arguments;
      if (Object.keys(fields).length > 0) setErrors(fields);
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  // A refusal of a field is said at the field; anything else is said below the form.
  const refused = Object.keys(refusedPaths(save.error)).length > 0;
  const heading =
    mode?.kind === 'edit'
      ? t('aiPower.http.endpointDialog.editTitle', { tool: mode.endpoint.title })
      : mode?.kind === 'add'
        ? t('aiPower.http.endpointDialog.addTitleTo', { name: mode.source.name })
        : t('aiPower.http.endpointDialog.addTitle');

  return (
    <AppDialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!save.isPending) onOpenChange(open);
      }}
      title={heading}
      description={t('aiPower.http.endpointDialog.description')}
      testId="http-endpoint-dialog"
      className="sm:max-w-2xl"
    >
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {mode?.kind === 'create' ? (
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
        ) : null}
        {mode?.kind === 'edit' ? (
          <p
            className="rounded-lg border border-border bg-surface-sunken p-3 text-sm text-text"
            data-testid="endpoint-edit-warning"
          >
            {t('aiPower.http.endpointDialog.editWarning')}
          </p>
        ) : null}
        <TextField
          id="ep-title"
          label={t('aiPower.http.endpointDialog.title')}
          hint={t('aiPower.http.endpointDialog.titleHint')}
          value={draft.title}
          maxLength={120}
          onChange={(event) => patch({ title: event.target.value })}
          error={errors['ep-title']}
        />
        <TextareaField
          id="ep-about"
          label={t('aiPower.http.endpointDialog.about')}
          hint={t('aiPower.http.endpointDialog.aboutHint')}
          value={draft.about}
          rows={3}
          maxLength={1000}
          onChange={(event) => patch({ about: event.target.value })}
          error={errors['ep-about']}
        />
        <div className="grid gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <SelectField
            id="ep-method"
            label={t('aiPower.http.endpointDialog.method')}
            value={draft.method}
            onChange={(event) => patch({ method: event.target.value as HttpToolMethod })}
            options={METHODS.map((m) => ({ value: m, label: m }))}
          />
          <TextField
            id="ep-path"
            label={t('aiPower.http.endpointDialog.path')}
            hint={t('aiPower.http.endpointDialog.pathHint')}
            value={draft.path}
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            placeholder="/orders/{orderId}"
            maxLength={300}
            onChange={(event) => patch({ path: event.target.value })}
            error={errors['ep-path']}
          />
        </div>
        <SelectField
          id="ep-risk"
          label={t('aiPower.http.endpointDialog.risk')}
          value={draft.risk}
          onChange={(event) => patch({ risk: event.target.value as '' | RiskClass })}
          options={[
            { value: '', label: t('aiPower.http.endpointDialog.riskDefault') },
            ...RISKS.map((r) => ({ value: r, label: t(`tools.risk.${r}`) })),
          ]}
        />

        <fieldset
          className="flex flex-col gap-3"
          aria-describedby="ep-details-hint"
          data-testid="http-details"
        >
          <legend className="text-sm font-semibold text-text">
            {t('aiPower.http.endpointDialog.details')}
          </legend>
          <p id="ep-details-hint" className="text-sm text-text-secondary">
            {t('aiPower.http.endpointDialog.detailsHint')}
          </p>
          {errors['ep-arguments'] ? (
            <p role="alert" id="ep-arguments" className="text-sm font-medium text-danger">
              {errors['ep-arguments']}
            </p>
          ) : null}
          {draft.args.length === 0 ? (
            <p className="text-sm text-text-secondary">
              {t('aiPower.http.endpointDialog.noDetails')}
            </p>
          ) : null}
          {draft.args.map((arg, index) => (
            <fieldset
              key={arg.uid}
              className="flex flex-col gap-3 rounded-lg border border-border p-3"
              data-testid="http-detail"
            >
              <legend className="px-1 text-xs font-medium text-text-secondary">
                {t('aiPower.http.endpointDialog.detailLabel', { n: index + 1 })}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  id={`ep-arg-${arg.uid}-name`}
                  label={t('aiPower.http.endpointDialog.detail.name')}
                  hint={t('aiPower.http.endpointDialog.detail.nameHint')}
                  value={arg.name}
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={64}
                  onChange={(event) => changeArg(arg.uid, { name: event.target.value })}
                  error={errors[`ep-arg-${arg.uid}-name`]}
                />
                <SelectField
                  id={`ep-arg-${arg.uid}-place`}
                  label={t('aiPower.http.endpointDialog.detail.place')}
                  value={arg.place}
                  onChange={(event) =>
                    changeArg(arg.uid, { place: event.target.value as HttpToolArgumentIn })
                  }
                  options={PLACES.map((p) => ({
                    value: p,
                    label: t(`aiPower.http.endpointDialog.detail.places.${p}`),
                  }))}
                />
                <SelectField
                  id={`ep-arg-${arg.uid}-type`}
                  label={t('aiPower.http.endpointDialog.detail.type')}
                  value={arg.type}
                  onChange={(event) =>
                    changeArg(arg.uid, { type: event.target.value as ValueType })
                  }
                  options={VALUE_TYPES.map((type) => ({
                    value: type,
                    label: t(`aiPower.http.endpointDialog.detail.types.${type}`),
                  }))}
                />
                <TextField
                  id={`ep-arg-${arg.uid}-key`}
                  label={t('aiPower.http.endpointDialog.detail.key')}
                  hint={t('aiPower.http.endpointDialog.detail.keyHint')}
                  labelNote={t('app.optional')}
                  value={arg.key}
                  dir="ltr"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={100}
                  onChange={(event) => changeArg(arg.uid, { key: event.target.value })}
                />
              </div>
              <TextField
                id={`ep-arg-${arg.uid}-about`}
                label={t('aiPower.http.endpointDialog.detail.about')}
                labelNote={t('app.optional')}
                value={arg.about}
                maxLength={300}
                onChange={(event) => changeArg(arg.uid, { about: event.target.value })}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CheckboxField
                  id={`ep-arg-${arg.uid}-required`}
                  label={
                    arg.place === 'path'
                      ? t('aiPower.http.endpointDialog.detail.requiredPath')
                      : t('aiPower.http.endpointDialog.detail.required')
                  }
                  checked={arg.place === 'path' || arg.required}
                  disabled={arg.place === 'path'}
                  onCheckedChange={(required) => changeArg(arg.uid, { required })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('aiPower.http.endpointDialog.removeDetail', { n: index + 1 })}
                  onClick={() =>
                    setDraft((d) => ({ ...d, args: d.args.filter((a) => a.uid !== arg.uid) }))
                  }
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            </fieldset>
          ))}
          {missing.length > 0 ? (
            <div
              className="flex flex-wrap items-center gap-2 text-sm text-text"
              data-testid="http-missing"
            >
              <span>
                {t('aiPower.http.endpointDialog.missing', {
                  names: missing.map((holder) => `{${holder}}`).join(', '),
                })}
              </span>
              {missing.map((holder) => (
                <Button
                  key={holder}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => addArg(pathArgument(holder))}
                >
                  {t('aiPower.http.endpointDialog.fill', { name: `{${holder}}` })}
                </Button>
              ))}
            </div>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            disabled={draft.args.length >= MOST_DETAILS}
            onClick={() =>
              addArg(
                newArgument({
                  place: draft.method === 'GET' || draft.method === 'DELETE' ? 'query' : 'body',
                }),
              )
            }
          >
            <PlusIcon aria-hidden="true" />
            {t('aiPower.http.endpointDialog.addDetail')}
          </Button>
        </fieldset>

        <ActionError error={isCancelled(save.error) || refused ? null : save.error} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending} data-testid="save-endpoint">
            {mode?.kind === 'edit'
              ? t('aiPower.http.endpointDialog.submitEdit')
              : t('aiPower.http.endpointDialog.submitAdd')}
          </Button>
        </DialogFooter>
      </form>
    </AppDialog>
  );
}
