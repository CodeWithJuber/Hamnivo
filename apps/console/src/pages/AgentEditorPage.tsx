import { Button } from '@hamnivo/ui/components/button';
import { FieldDescription, FieldLegend, FieldSet } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { UnsavedChangesDialog } from '@hamnivo/ui/components/unsaved-changes-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useParams } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  InfoIcon,
  PlusIcon,
  RocketIcon,
  SaveIcon,
  Trash2Icon,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AgentVersions } from '../components/AgentVersions';
import { ConfirmDialog } from '../components/AppDialog';
import { VisibilityBadge } from '../components/Badges';
import {
  CheckboxField,
  ChoiceField,
  SelectField,
  TextareaField,
  TextField,
} from '../components/Fields';
import { PageHeader } from '../components/PageHeader';
import { ActionError, QueryState } from '../components/States';
import { LANGUAGE_NAMES } from '../i18n';
import {
  type AgentForm,
  differences,
  FIELD_IDS,
  fieldForPath,
  LISTED_LANGUAGES,
  type ModelRow,
  PROVIDERS,
  type SectionKey,
  sameConfig,
  toConfig,
  toForm,
} from '../lib/agent-form';
import { api, isApiError } from '../lib/api';
import { returnFocus, useOpener } from '../lib/focus';
import { useNames } from '../lib/names';
import { keys, useAgent, useModelConnections, useSources } from '../lib/queries';
import { isCancelled, withReauth } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import type { AgentConfig, AgentDetail, AgentVersion, ModelProviderKind } from '../lib/types';

/** The version the form started from: the draft, or the live version when there is none. */
interface Base {
  version: number | undefined;
  config: AgentConfig;
}

interface Conflict {
  /** The version now on the server; null when the draft was published and none replaced it. */
  version: number | null;
  config: AgentConfig;
}

function sectionLabel(t: TFunction, key: SectionKey): string {
  switch (key) {
    case 'displayName':
      return t('editor.displayName');
    case 'purpose':
      return t('editor.purpose');
    case 'instructions':
      return t('editor.instructions');
    case 'tone':
      return t('editor.tone');
    case 'languages':
      return t('editor.languages');
    case 'mode':
      return t('editor.mode');
    case 'model':
      return t('editor.sections.model');
    case 'fallback':
      return t('editor.fallback');
    case 'limits':
      return t('editor.sections.limits');
    case 'knowledge':
      return t('editor.sections.knowledge');
    case 'memory':
      return t('editor.sections.memory');
  }
}

function FormSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-5 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
    >
      <h2 id={`${id}-title`} className="text-lg font-semibold text-text">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModelFields({
  idPrefix,
  row,
  onChange,
  disabled,
  error,
}: {
  idPrefix: string;
  row: ModelRow;
  onChange: (row: ModelRow) => void;
  disabled: boolean;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const connections = useModelConnections();
  const usable = (connections.data?.items ?? []).filter(
    (c) => c.provider === row.provider && c.status === 'active',
  );
  const options = [
    { value: '', label: t('editor.platformKey') },
    ...usable.map((c) => ({
      value: c.id,
      label: `${c.label} (${t('models.keyEnding', { hint: c.keyHint })})`,
    })),
  ];
  if (row.connectionId && !usable.some((c) => c.id === row.connectionId)) {
    options.push({
      value: row.connectionId,
      label: t('editor.unknownConnection', { id: row.connectionId }),
    });
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <SelectField
        id={`${idPrefix}-provider`}
        label={t('editor.provider')}
        value={row.provider}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            provider: event.target.value as ModelProviderKind,
            modelId: event.target.value === 'mock' ? 'hamnivo-mock' : '',
            connectionId: '',
          })
        }
        options={PROVIDERS.map((p) => ({ value: p, label: t(`editor.providers.${p}`) }))}
      />
      <TextField
        id={`${idPrefix}-modelId`}
        label={t('editor.modelId')}
        hint={t('editor.modelIdHint')}
        value={row.modelId}
        dir="ltr"
        spellCheck={false}
        disabled={disabled}
        maxLength={200}
        onChange={(event) => onChange({ ...row, modelId: event.target.value })}
        error={error}
      />
      {row.provider !== 'mock' ? (
        <div className="sm:col-span-2">
          <SelectField
            id={`${idPrefix}-connection`}
            label={t('editor.credentials')}
            hint={
              can('integrations.manage')
                ? t('editor.credentialsHint')
                : t('editor.connectionsHidden')
            }
            value={row.connectionId}
            disabled={disabled || !can('integrations.manage')}
            onChange={(event) => onChange({ ...row, connectionId: event.target.value })}
            options={options}
          />
        </div>
      ) : null}
    </div>
  );
}

function Editor({ detail }: { detail: AgentDetail }) {
  const { t } = useTranslation();
  const { tenantId, can } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const names = useNames();
  const sources = useSources();
  const agent = detail.agent;
  const start = detail.draft ?? detail.published;
  const [base, setBase] = useState<Base | null>(
    start ? { version: detail.draft?.version, config: start.config } : null,
  );
  const [initial, setInitial] = useState<AgentForm | null>(start ? toForm(start.config) : null);
  const [form, setForm] = useState<AgentForm | null>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  // What the dialog asks about, fixed when it opens so its words don't change while it closes.
  const [publishTarget, setPublishTarget] = useState({ version: 1, replacing: 0 });
  const editable = can('agents.manage') && agent.status === 'active';
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });
  // Where to put focus back when the person stays on the page.
  const leaveOpener = useOpener(blocker.status === 'blocked');

  const agentKey = [tenantId, ...keys.agent(agent.id)];
  // Part of saving and publishing, so an ended session asks to sign in again and carries on.
  const latest = () =>
    withReauth(() =>
      client.fetchQuery({
        queryKey: agentKey,
        queryFn: () => api<AgentDetail>(`/v1/admin/agents/${agent.id}`, { tenant: tenantId }),
        staleTime: 0,
      }),
    );
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: agentKey }),
      client.invalidateQueries({ queryKey: [tenantId, ...keys.agents], exact: true }),
    ]);

  if (!form || !base || !initial) return null;
  const update = (patch: Partial<AgentForm>) => {
    setForm({ ...form, ...patch });
    setStatus(null);
  };

  const showConflict = (server: AgentDetail) => {
    const theirs = server.draft ?? server.published;
    if (!theirs) return;
    setConflict({ version: server.draft?.version ?? null, config: theirs.config });
    announce(t('editor.conflict.title'), 'assertive');
  };

  /** Saves the draft with the version it started from; returns whether it was saved. */
  const save = async (overwrite?: Base): Promise<boolean> => {
    setAttempted(true);
    const result = toConfig(form, t);
    if (result.errors) {
      setErrors(result.errors);
      return false;
    }
    setErrors({});
    setSaving(true);
    setSaveError(null);
    setStatus(null);
    const from = overwrite ?? base;
    try {
      if (!overwrite) {
        // The gateway compares version numbers only, and none at all when this page started
        // without a draft. So check for a draft started, or edited, since this page loaded.
        const server = await latest();
        const theirs = server.draft;
        if (
          theirs &&
          (from.version === undefined ||
            (theirs.version === from.version && !sameConfig(theirs.config, from.config)))
        ) {
          showConflict(server);
          return false;
        }
      }
      const saved = await withReauth(() =>
        api<AgentVersion>(`/v1/admin/agents/${agent.id}/draft`, {
          method: 'PUT',
          tenant: tenantId,
          body: {
            config: result.config,
            ...(from.version !== undefined ? { baseVersion: from.version } : {}),
          },
        }),
      );
      setBase({ version: saved.version, config: saved.config });
      const savedForm = toForm(saved.config);
      setForm(savedForm);
      setInitial(savedForm);
      setConflict(null);
      const message = t('editor.saved', { version: saved.version });
      setStatus(message);
      announce(message);
      await refresh();
      return true;
    } catch (error) {
      const server = isApiError(error, 'VERSION_CONFLICT')
        ? await latest().catch(() => null)
        : null;
      if (server) {
        showConflict(server);
      } else if (isApiError(error, 'VALIDATION_FAILED') && error.fields.length > 0) {
        const mapped: Record<string, string> = {};
        for (const field of error.fields) {
          const id = fieldForPath(field.path);
          if (id) mapped[id] = field.message;
        }
        setErrors(mapped);
        setSaveError(error);
      } else if (!isCancelled(error)) {
        setSaveError(error);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  const draftVersion = base.version;
  const published = detail.agent.publishedVersion;
  const publishReason = !can('agents.publish')
    ? t('editor.publishWhy.noPermission')
    : agent.status !== 'active'
      ? t('editor.publishWhy.archived')
      : dirty
        ? t('editor.publishWhy.unsaved')
        : draftVersion === undefined
          ? t('editor.publishWhy.noDraft')
          : null;

  const publish = async (version: number) => {
    // Publish only what this person reviewed: stop if the draft changed on the server.
    const server = await latest();
    if (
      !server.draft ||
      server.draft.version !== version ||
      !sameConfig(server.draft.config, base.config)
    ) {
      setPublishOpen(false);
      showConflict(server);
      return;
    }
    await withReauth(() =>
      api<AgentDetail>(`/v1/admin/agents/${agent.id}/publish`, {
        method: 'POST',
        tenant: tenantId,
        body: { version },
      }),
    );
    setBase({ version: undefined, config: base.config });
    const message = t('editor.published', { version });
    setStatus(message);
    announce(message);
    await refresh();
  };

  const summary = attempted
    ? Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }))
    : [];
  const brandSources = (sources.data?.items ?? []).filter(
    (s) => s.brandId === agent.brandId && s.status !== 'retired',
  );
  const theirs = conflict ? toForm(conflict.config) : null;
  const changed = theirs ? differences(form, theirs) : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={
          <Link
            to="/agents"
            className="inline-flex w-fit items-center gap-1 text-sm text-link underline underline-offset-4 hover:no-underline"
          >
            <ArrowLeftIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
            {t('editor.allAgents')}
          </Link>
        }
        title={agent.name}
        description={t('editor.brand', { name: names.brand(agent.brandId) ?? agent.brandId })}
        actions={
          <span className="flex flex-wrap gap-2">
            {published ? (
              <StatusBadge tone="success">
                {t('status.agent.live', { version: published })}
              </StatusBadge>
            ) : (
              <StatusBadge tone="warning">{t('agents.notPublished')}</StatusBadge>
            )}
            {draftVersion !== undefined ? (
              <StatusBadge tone="info">{t('agents.draft', { version: draftVersion })}</StatusBadge>
            ) : null}
          </span>
        }
      />

      <div
        role="note"
        data-testid="not-live-banner"
        className="flex items-start gap-3 rounded-lg border border-info/30 bg-info-subtle p-4 text-sm"
      >
        <InfoIcon className="mt-0.5 size-5 shrink-0 text-info" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-semibold text-text">{t('editor.notLive.title')}</p>
          <p className="text-text">
            {published
              ? t('editor.notLive.live', { version: published })
              : t('editor.notLive.none')}
          </p>
          {draftVersion !== undefined && draftVersion !== published ? (
            <p className="text-text-secondary">
              {t('editor.notLive.draftAhead', { version: draftVersion })}
            </p>
          ) : null}
        </div>
      </div>

      {conflict && theirs ? (
        <section
          role="alert"
          data-testid="conflict"
          aria-labelledby="conflict-title"
          className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-4"
        >
          <h2 id="conflict-title" className="flex items-center gap-2 font-semibold text-text">
            <CircleAlertIcon className="size-5 text-warning" aria-hidden="true" />
            {t('editor.conflict.title')}
          </h2>
          <p className="text-sm text-text">
            {t('editor.conflict.body', { version: conflict.version ?? published ?? '' })}
          </p>
          {changed.length > 0 ? (
            <div className="text-sm">
              <p className="text-text">{t('editor.conflict.differences')}</p>
              <ul className="list-disc ps-5 text-text">
                {changed.map((key) => (
                  <li key={key}>{sectionLabel(t, key)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-text-secondary">{t('editor.conflict.same')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                const loaded = toForm(conflict.config);
                setForm(loaded);
                setInitial(loaded);
                setBase({ version: conflict.version ?? undefined, config: conflict.config });
                setConflict(null);
                setErrors({});
              }}
            >
              {t('editor.conflict.loadTheirs')}
            </Button>
            <span className="flex flex-col gap-1">
              <Button
                busy={saving}
                onClick={() =>
                  void save({ version: conflict.version ?? undefined, config: conflict.config })
                }
                aria-describedby="keep-mine-hint"
              >
                {t('editor.conflict.keepMine')}
              </Button>
              <span id="keep-mine-hint" className="text-xs text-text-secondary">
                {t('editor.conflict.keepMineHint')}
              </span>
            </span>
          </div>
        </section>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <form
          className="flex min-w-0 flex-col gap-6"
          onSubmit={submit}
          noValidate
          aria-labelledby="page-title"
        >
          {!editable ? (
            <p className="rounded-lg border border-border bg-surface-muted p-3 text-sm text-text-secondary">
              {t('editor.readOnly')}
            </p>
          ) : null}
          <FormErrorSummary title={t('editor.errors.summary')} errors={summary} />

          <FormSection id="section-identity" title={t('editor.sections.identity')}>
            <TextField
              id={FIELD_IDS.displayName}
              label={t('editor.displayName')}
              hint={t('editor.displayNameHint')}
              value={form.displayName}
              maxLength={60}
              disabled={!editable}
              onChange={(event) => update({ displayName: event.target.value })}
              error={errors[FIELD_IDS.displayName]}
            />
            <TextareaField
              id={FIELD_IDS.purpose}
              label={t('editor.purpose')}
              hint={t('editor.purposeHint')}
              value={form.purpose}
              rows={2}
              disabled={!editable}
              onChange={(event) => update({ purpose: event.target.value })}
              error={errors[FIELD_IDS.purpose]}
            />
          </FormSection>

          <FormSection id="section-behaviour" title={t('editor.sections.behaviour')}>
            <TextareaField
              id={FIELD_IDS.instructions}
              label={t('editor.instructions')}
              hint={t('editor.instructionsHint')}
              value={form.instructions}
              rows={6}
              disabled={!editable}
              onChange={(event) => update({ instructions: event.target.value })}
              error={errors[FIELD_IDS.instructions]}
            />
            <ChoiceField
              id="agent-tone"
              legend={t('editor.tone')}
              value={form.tone}
              disabled={!editable}
              columns
              onValueChange={(value) => update({ tone: value as AgentForm['tone'] })}
              choices={(['warm', 'neutral', 'formal'] as const).map((value) => ({
                value,
                label: t(`editor.tones.${value}`),
                hint: t(`editor.tones.${value}Hint`),
              }))}
            />
            <FieldSet className="gap-3">
              <FieldLegend variant="label" className="mb-0">
                {t('editor.languages')}
              </FieldLegend>
              <FieldDescription className="mt-0">{t('editor.languagesHint')}</FieldDescription>
              <div className="grid gap-3 sm:grid-cols-2">
                {LISTED_LANGUAGES.map((tag) => (
                  <CheckboxField
                    key={tag}
                    id={`agent-lang-${tag}`}
                    label={
                      <span>
                        <span lang={tag}>{LANGUAGE_NAMES[tag]}</span>{' '}
                        <bdi dir="ltr" className="text-text-secondary">
                          ({tag})
                        </bdi>
                      </span>
                    }
                    checked={form.languages.includes(tag)}
                    disabled={!editable}
                    onCheckedChange={(checked) =>
                      update({
                        languages: checked
                          ? [...form.languages, tag]
                          : form.languages.filter((l) => l !== tag),
                      })
                    }
                  />
                ))}
              </div>
              {errors[FIELD_IDS.languages] ? (
                <p role="alert" className="text-sm text-danger">
                  {errors[FIELD_IDS.languages]}
                </p>
              ) : null}
            </FieldSet>
            <TextField
              id={FIELD_IDS.otherLanguages}
              label={t('editor.otherLanguages')}
              hint={t('editor.otherLanguagesHint')}
              value={form.otherLanguages}
              dir="ltr"
              spellCheck={false}
              disabled={!editable}
              onChange={(event) => update({ otherLanguages: event.target.value })}
              error={errors[FIELD_IDS.otherLanguages]}
            />
            <ChoiceField
              id="agent-mode"
              legend={t('editor.mode')}
              value={form.mode}
              disabled={!editable}
              onValueChange={(value) => update({ mode: value as AgentForm['mode'] })}
              choices={(['answer', 'assist'] as const).map((value) => ({
                value,
                label: t(`editor.modes.${value}`),
                hint: t(`editor.modes.${value}Hint`),
              }))}
            />
          </FormSection>

          <FormSection id="section-model" title={t('editor.sections.model')}>
            <ModelFields
              idPrefix="agent-model"
              row={form.model}
              disabled={!editable}
              onChange={(model) => update({ model })}
              error={errors[FIELD_IDS.modelId]}
            />
            <FieldSet className="gap-4">
              <FieldLegend variant="label" className="mb-0">
                {t('editor.fallback')}
              </FieldLegend>
              <FieldDescription className="mt-0">{t('editor.fallbackHint')}</FieldDescription>
              {form.fallbacks.map((row, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: fallbacks are an ordered list without ids
                  key={index}
                  className="flex flex-col gap-3 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-text">
                      {t('editor.fallbackItem', { n: index + 1 })}
                    </p>
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          update({ fallbacks: form.fallbacks.filter((_, i) => i !== index) })
                        }
                      >
                        <Trash2Icon aria-hidden="true" />
                        {t('editor.removeFallback', { n: index + 1 })}
                      </Button>
                    ) : null}
                  </div>
                  <ModelFields
                    idPrefix={`agent-fallback-${index}`}
                    row={row}
                    disabled={!editable}
                    onChange={(next) =>
                      update({
                        fallbacks: form.fallbacks.map((r, i) => (i === index ? next : r)),
                      })
                    }
                    error={errors[FIELD_IDS.fallbackModelId(index)]}
                  />
                </div>
              ))}
              {editable && form.fallbacks.length < 2 ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="self-start"
                  onClick={() =>
                    update({
                      fallbacks: [
                        ...form.fallbacks,
                        { provider: 'mock', modelId: 'hamnivo-mock', connectionId: '' },
                      ],
                    })
                  }
                >
                  <PlusIcon aria-hidden="true" />
                  {t('editor.addFallback')}
                </Button>
              ) : null}
            </FieldSet>
          </FormSection>

          <FormSection id="section-limits" title={t('editor.sections.limits')}>
            <p className="text-sm text-text-secondary">{t('editor.limits.hint')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id={FIELD_IDS.maxOutputTokens}
                label={t('editor.limits.maxOutputTokens')}
                inputMode="numeric"
                value={form.maxOutputTokens}
                disabled={!editable}
                onChange={(event) => update({ maxOutputTokens: event.target.value })}
                error={errors[FIELD_IDS.maxOutputTokens]}
              />
              <TextField
                id={FIELD_IDS.timeoutSeconds}
                label={t('editor.limits.timeout')}
                inputMode="decimal"
                value={form.timeoutSeconds}
                disabled={!editable}
                onChange={(event) => update({ timeoutSeconds: event.target.value })}
                error={errors[FIELD_IDS.timeoutSeconds]}
              />
              <TextField
                id={FIELD_IDS.historyMessages}
                label={t('editor.limits.historyMessages')}
                inputMode="numeric"
                value={form.historyMessages}
                disabled={!editable}
                onChange={(event) => update({ historyMessages: event.target.value })}
                error={errors[FIELD_IDS.historyMessages]}
              />
              <TextField
                id={FIELD_IDS.maxSteps}
                label={t('editor.limits.maxSteps')}
                inputMode="numeric"
                value={form.maxSteps}
                disabled={!editable}
                onChange={(event) => update({ maxSteps: event.target.value })}
                error={errors[FIELD_IDS.maxSteps]}
              />
            </div>
          </FormSection>

          <FormSection id="section-knowledge" title={t('editor.sections.knowledge')}>
            <p className="text-sm text-text-secondary">{t('editor.knowledge.hint')}</p>
            {!can('knowledge.read') ? (
              <p className="text-sm text-text-secondary">{t('editor.knowledge.hidden')}</p>
            ) : brandSources.length === 0 ? (
              <p className="text-sm text-text-secondary">
                {t('editor.knowledge.none')}{' '}
                <Link to="/knowledge" className="text-link underline underline-offset-4">
                  {t('editor.knowledge.manage')}
                </Link>
              </p>
            ) : (
              <ul id={FIELD_IDS.knowledge} tabIndex={-1} className="flex flex-col gap-3">
                {brandSources.map((source) => (
                  <li key={source.id} className="flex flex-wrap items-center gap-3">
                    <CheckboxField
                      id={`agent-source-${source.id}`}
                      label={<bdi>{source.name}</bdi>}
                      checked={form.knowledgeSourceIds.includes(source.id)}
                      disabled={!editable}
                      onCheckedChange={(checked) =>
                        update({
                          knowledgeSourceIds: checked
                            ? [...form.knowledgeSourceIds, source.id]
                            : form.knowledgeSourceIds.filter((id) => id !== source.id),
                        })
                      }
                    />
                    <VisibilityBadge visibility={source.visibility} />
                  </li>
                ))}
              </ul>
            )}
          </FormSection>

          <FormSection id="section-memory" title={t('editor.sections.memory')}>
            <CheckboxField
              id={FIELD_IDS.memoryEnabled}
              label={t('editor.memory.enabled')}
              hint={t('editor.memory.hint')}
              checked={form.memoryEnabled}
              disabled={!editable}
              onCheckedChange={(checked) => update({ memoryEnabled: checked })}
            />
            {form.memoryEnabled ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id={FIELD_IDS.memoryMaxItems}
                  label={t('editor.memory.maxItems')}
                  inputMode="numeric"
                  value={form.memoryMaxItems}
                  disabled={!editable}
                  onChange={(event) => update({ memoryMaxItems: event.target.value })}
                  error={errors[FIELD_IDS.memoryMaxItems]}
                />
                <TextField
                  id={FIELD_IDS.memoryMaxChars}
                  label={t('editor.memory.maxChars')}
                  inputMode="numeric"
                  value={form.memoryMaxChars}
                  disabled={!editable}
                  onChange={(event) => update({ memoryMaxChars: event.target.value })}
                  error={errors[FIELD_IDS.memoryMaxChars]}
                />
              </div>
            ) : null}
          </FormSection>

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-3 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            <ActionError error={saveError} />
            <div className="flex flex-wrap items-center gap-3">
              <p className="me-auto text-sm" aria-live="polite" data-testid="save-state">
                {dirty ? (
                  <span className="font-medium text-warning">{t('editor.unsaved')}</span>
                ) : status ? (
                  <span className="text-success">{status}</span>
                ) : (
                  <span className="text-text-secondary">{t('editor.allSaved')}</span>
                )}
              </p>
              {editable && dirty ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setForm(initial);
                    setErrors({});
                    setAttempted(false);
                  }}
                >
                  {t('editor.discard')}
                </Button>
              ) : null}
              {editable ? (
                <Button type="submit" variant={dirty ? 'default' : 'secondary'} busy={saving}>
                  {saving ? null : <SaveIcon aria-hidden="true" />}
                  {t('editor.save')}
                </Button>
              ) : null}
              <ReasonedAction reason={publishReason}>
                <Button
                  type="button"
                  variant="brand"
                  onClick={() => {
                    if (draftVersion === undefined) return;
                    setPublishTarget({ version: draftVersion, replacing: published ?? 0 });
                    setPublishOpen(true);
                  }}
                  id="agent-publish"
                  data-testid="publish-button"
                >
                  <RocketIcon aria-hidden="true" />
                  {draftVersion === undefined
                    ? t('editor.publishNone')
                    : t('editor.publish', { version: draftVersion })}
                </Button>
              </ReasonedAction>
            </div>
          </div>
        </form>

        <aside className="flex min-w-0 flex-col gap-6" aria-labelledby="versions-title">
          <AgentVersions
            agentId={agent.id}
            publishedVersion={published}
            onRollback={async (version) => {
              await withReauth(() =>
                api<AgentDetail>(`/v1/admin/agents/${agent.id}/publish`, {
                  method: 'POST',
                  tenant: tenantId,
                  body: { version },
                }),
              );
              const message = t('editor.versions.rolledBack', { version });
              setStatus(message);
              announce(message);
              await refresh();
            }}
          />
        </aside>
      </div>

      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title={t('editor.publishConfirm.title', { version: publishTarget.version })}
        confirmLabel={t('editor.publishConfirm.submit')}
        variant="brand"
        testId="publish-dialog"
        // Publishing replaces the button (it now explains why it is unavailable).
        fallbackFocus={() => document.getElementById('agent-publish')}
        failureNote={t('editor.publishFailed', { version: publishTarget.version })}
        onConfirm={() => publish(publishTarget.version)}
      >
        <p>{t('editor.publishConfirm.body', { version: publishTarget.version })}</p>
        <p className="text-text-secondary">
          {publishTarget.replacing
            ? t('editor.publishConfirm.replaces', { version: publishTarget.replacing })
            : t('editor.publishConfirm.first')}
        </p>
      </ConfirmDialog>

      <UnsavedChangesDialog
        open={blocker.status === 'blocked'}
        title={t('editor.leave.title')}
        description={t('editor.leave.description')}
        saveLabel={t('editor.leave.save')}
        discardLabel={t('editor.leave.discard')}
        stayLabel={t('editor.leave.stay')}
        onSave={async () => {
          if (await save()) {
            blocker.proceed?.();
            return;
          }
          blocker.reset?.();
          // A failed save shows its reasons in the summary; start there.
          requestAnimationFrame(() =>
            returnFocus(
              document.querySelector('[data-slot="form-error-summary"]') ?? leaveOpener.current,
            ),
          );
        }}
        onDiscard={() => blocker.proceed?.()}
        onStay={() => {
          blocker.reset?.();
          requestAnimationFrame(() => returnFocus(leaveOpener.current));
        }}
      />
    </div>
  );
}

/** Agent studio editor (board 11: HNV-11-02 draft, 11-05 blocked release, 11-06 publish/rollback). */
export function AgentEditorPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { agentId } = useParams({ from: '/_studio/agents/$agentId' });
  const agent = useAgent(agentId);
  return (
    <QueryState query={agent} label={t('editor.loading')} permitted={can('agents.read')}>
      {(detail) => <Editor key={detail.agent.id} detail={detail} />}
    </QueryState>
  );
}
