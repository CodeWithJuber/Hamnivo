import { EVENT_SECONDS } from '@hamnivo/domain/automations';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { Switch } from '@hamnivo/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@hamnivo/ui/components/toggle-group';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { ArrowLeftIcon, PlusIcon, RefreshCwIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { PageHeader } from '../../components/PageHeader';
import { ActionError, Forbidden, QueryState } from '../../components/States';
import { isApiError } from '../../lib/api';
import {
  type Automation,
  type AutomationDraft,
  type AutomationEventType,
  automationKeys,
  bodyOf,
  controlOfPath,
  type DraftProblem,
  draftOf,
  enabledRequest,
  eventsOf,
  freeKey,
  hasSeconds,
  automationIds as ids,
  isDirty,
  MAX_ACTIONS,
  MAX_CONDITIONS,
  NAME_MAX,
  newAction,
  newCondition,
  nextActionType,
  nextField,
  problemControl,
  problemsOf,
  publishRequest,
  restoreRequest,
  type SampleFacts,
  sampleFactsFor,
  saveRequest,
  statusOf,
  TEXT_VALUE_MAX,
  useAutomation,
  useAutomationChange,
  useAutomationOptions,
  VISITS_MAX,
  VISITS_MIN,
  warningControl,
  warningsOf,
} from '../../lib/automations';
import { DOCS } from '../../lib/docs';
import { formatRelative } from '../../lib/format';
import { isCancelled } from '../../lib/reauth';
import { useTenant } from '../../lib/tenant';
import { LeaveGuard } from '../settings/DiscardChangesDialog';
import { firstPreviewLanguage } from '../settings/PreviewColumn';
import { StatusText } from './AutomationsPage';
import { RunsPanel, VersionsPanel } from './HistoryPanels';
import { ActionRow, ConditionRow, Warning } from './RuleRows';
import { TryItPanel, useWide } from './TryItPanel';

/** What a problem says, in the language of the page. */
export function problemText(problem: DraftProblem, t: TFunction): string {
  const p = 'automations.editor.problems';
  switch (problem.kind) {
    case 'name':
      return t(`${p}.name`);
    case 'seconds':
      return t(`${p}.seconds`, { min: problem.min, max: problem.max });
    case 'conditionValue':
      return t(`${p}.conditionValue`, { number: problem.index + 1 });
    case 'conditionNumber':
      return t(`${p}.conditionNumber`, {
        number: problem.index + 1,
        min: VISITS_MIN,
        max: VISITS_MAX,
      });
    case 'conditionLong':
      return t(`${p}.conditionLong`, { number: problem.index + 1, max: TEXT_VALUE_MAX });
    case 'messageEnglish':
      return t(`${p}.messageEnglish`, { number: problem.index + 1 });
    case 'messageLong':
      return t(`${p}.messageLong`, { number: problem.index + 1, max: problem.max });
    case 'note':
      return t(`${p}.note`, { number: problem.index + 1 });
    case 'tag':
      return t(`${p}.tag`, { number: problem.index + 1 });
    case 'team':
      return t(`${p}.team`, { number: problem.index + 1 });
    case 'noActions':
      return t(`${p}.noActions`);
  }
}

/** Puts focus on a control once the change that made it has been drawn. */
const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** One numbered part of the rule: 1 When, 2 If, 3 Then. */
function Step({
  id,
  number,
  title,
  description,
  aside,
  children,
}: {
  id: string;
  number: number;
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      data-testid={`step-${id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-sm font-semibold text-text"
          >
            {number}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={`${id}-title`} tabIndex={-1} className="text-lg font-semibold text-text">
              {title}
            </h2>
            <p className="text-sm text-text-secondary">{description}</p>
          </div>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

type ErrorList = { fieldId: string; message: string }[];

function Editor({ initial }: { initial: Automation }) {
  const { t, i18n } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const latest = useAutomation(initial.id);
  const [base, setBase] = useState<Automation>(initial);
  const saved = useMemo(() => draftOf(base.name, base.draft), [base]);
  const [draft, setDraft] = useState<AutomationDraft>(saved);
  const options = useAutomationOptions(base.brandId);
  const [sample, setSample] = useState<SampleFacts>(() =>
    sampleFactsFor(firstPreviewLanguage(i18n.language)),
  );
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<ErrorList>([]);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | null>(null);
  const save = useAutomationChange(base.id, saveRequest);
  const publish = useAutomationChange(base.id, publishRequest);
  const toggle = useAutomationChange(base.id, enabledRequest);
  const restore = useAutomationChange(base.id, restoreRequest);
  const manage = can('automations.manage');
  const reason = manage ? null : t('automations.noPermission');
  const kind = base.kind;
  const dirty = isDirty(draft, saved);

  const problems = problemsOf(draft);
  const warnings = warningsOf(draft);
  const messages = new Map<string, string>();
  for (const problem of problems) {
    const id = problemControl(problem);
    const text = problemText(problem, t);
    messages.set(id, messages.has(id) ? `${messages.get(id)} ${text}` : text);
  }
  for (const [id, text] of Object.entries(server)) if (!messages.has(id)) messages.set(id, text);
  const errors: Record<string, string> = attempted ? Object.fromEntries(messages) : {};
  const warningText = (code: string) =>
    t(`automations.editor.warnings.${code as 'prompt_required'}`);
  const rowWarning = (area: 'conditions' | 'actions', index: number) => {
    const found = warnings.filter((w) => w.path[0] === area && w.path[1] === index);
    return found.length > 0 ? found.map((w) => warningText(w.code)).join(' ') : null;
  };
  const ruleWarnings = warnings.filter((w) => w.path.length === 1);

  const change = (next: AutomationDraft) => {
    setDraft(next);
    setServer({});
  };

  /** What was saved is the new starting point at once, without waiting for a reload. */
  const adopt = (result: Automation, keepDraft = false) => {
    setBase(result);
    if (!keepDraft) setDraft(draftOf(result.name, result.draft));
    client.setQueryData([tenantId, ...automationKeys.one(result.id)], result);
  };

  const failed = (error: unknown) => {
    if (isCancelled(error)) return;
    if (isApiError(error, 'VERSION_CONFLICT')) {
      setConflict(true);
      return;
    }
    if (isApiError(error, 'VALIDATION_FAILED') && error.fields.length > 0) {
      const fields: Record<string, string> = {};
      for (const field of error.fields) {
        const id = controlOfPath(field.path, draft);
        fields[id] = fields[id] ? `${fields[id]} ${field.message}` : field.message;
      }
      setServer(fields);
      setSummary(Object.entries(fields).map(([fieldId, message]) => ({ fieldId, message })));
      return;
    }
    setFailure(error);
  };

  const start = (blocking: ErrorList) => {
    setAttempted(true);
    setServer({});
    setFailure(null);
    setConflict(false);
    setSummary(blocking);
    return blocking.length === 0;
  };

  const listed = (): ErrorList => [...messages].map(([fieldId, message]) => ({ fieldId, message }));

  const saveDraft = async (): Promise<Automation | null> => {
    try {
      const result = await save.mutateAsync({ ...bodyOf(draft), revision: base.revision });
      adopt(result);
      return result;
    } catch (error) {
      failed(error);
      return null;
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!manage || !start(listed())) return;
    setBusy('save');
    const result = await saveDraft();
    setBusy(null);
    if (result) announce(t('automations.editor.saved', { name: result.name }));
  };

  const publishNow = async () => {
    if (!manage) return;
    const blocking = [
      ...listed(),
      ...warnings.map((warning) => ({
        fieldId: warningControl(warning, draft),
        message: warningText(warning.code),
      })),
    ].filter((item, index, all) => all.findIndex((x) => x.fieldId === item.fieldId) === index);
    if (!start(blocking)) return;
    setBusy('publish');
    try {
      const current = dirty ? await saveDraft() : base;
      if (!current) return;
      const result = await publish.mutateAsync(current.revision);
      adopt(result);
      announce(
        t('automations.editor.published', {
          name: result.name,
          version: result.published?.version ?? 0,
        }),
      );
    } catch (error) {
      failed(error);
    } finally {
      setBusy(null);
    }
  };

  const reload = async () => {
    const fresh = await latest.refetch();
    if (!fresh.data) return;
    adopt(fresh.data);
    setConflict(false);
    setSummary([]);
    setServer({});
    setAttempted(false);
    announce(t('automations.editor.reloaded'));
  };

  const setEvent = (event: AutomationEventType) => {
    const range = EVENT_SECONDS[event];
    const seconds = Number(draft.seconds);
    change({
      ...draft,
      event,
      seconds:
        Number.isInteger(seconds) && seconds >= range.min && seconds <= range.max && range.max > 0
          ? draft.seconds
          : String(range.default),
    });
  };

  const status = statusOf(base);
  const statusLine = () => {
    const parts: string[] = [];
    if (base.published) {
      const when = formatRelative(base.published.publishedAt);
      parts.push(
        base.published.publishedBy === null
          ? t('automations.editor.statusLine.publishedBySystem', {
              version: base.published.version,
              when,
            })
          : t('automations.editor.statusLine.published', {
              version: base.published.version,
              who: base.published.publishedByName ?? base.published.publishedBy,
              when,
            }),
      );
    }
    if (status.key === 'draft') parts.push(t('automations.editor.statusLine.draft'));
    if (status.key === 'changes') parts.push(t('automations.editor.statusLine.changes'));
    if (status.key === 'off') parts.push(t('automations.editor.statusLine.off'));
    return parts.join(' ');
  };

  // Try it sits beside the form on wide screens, and opens and closes under it on phones.
  const wide = useWide();
  const tryIt = (
    <TryItPanel
      kind={kind}
      draft={draft}
      options={options.data}
      sample={sample}
      onSampleChange={setSample}
      wide={wide}
    />
  );
  const conditionsFull = draft.conditions.length >= MAX_CONDITIONS;
  const actionsFull = draft.actions.length >= MAX_ACTIONS;
  const name = base.name;

  return (
    <div className="flex flex-col gap-6" data-testid="automation-editor" data-kind={kind}>
      <LeaveGuard dirty={dirty && manage} />
      <PageHeader
        title={name}
        description={t(`automations.editor.kinds.${kind}`)}
        eyebrow={
          <Link
            to="/automations"
            search={{ brand: base.brandId }}
            className="flex items-center gap-1 text-sm text-link underline underline-offset-4 hover:no-underline"
          >
            <ArrowLeftIcon className="size-4 rtl:rotate-180" aria-hidden="true" />
            {t('automations.editor.back')}
          </Link>
        }
        actions={<StatusText automation={base} />}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          <form
            className="flex min-w-0 flex-col gap-6"
            onSubmit={submit}
            noValidate
            data-testid="automation-form"
          >
            <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
            {conflict ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text"
                data-testid="automation-conflict"
              >
                <span className="min-w-0 flex-1">{t('automations.editor.conflict')}</span>
                <Button type="button" variant="secondary" size="sm" onClick={() => void reload()}>
                  <RefreshCwIcon aria-hidden="true" />
                  {t('automations.editor.reload')}
                </Button>
              </div>
            ) : null}
            <p>
              <GuideLink href={DOCS.automation.automations}>{t('automations.guide')}</GuideLink>
            </p>
            <div className="max-w-xl">
              <TextField
                id={ids.name}
                label={t('automations.editor.name')}
                hint={t('automations.editor.nameHint')}
                value={draft.name}
                maxLength={NAME_MAX}
                error={errors[ids.name]}
                onChange={(event) => change({ ...draft, name: event.target.value })}
              />
            </div>

            <Step
              id="when"
              number={1}
              title={t('automations.editor.whenStep.title')}
              description={t('automations.editor.whenStep.description')}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  id={ids.event}
                  label={t('automations.editor.whenStep.event')}
                  hint={t('automations.editor.whenStep.kindNote')}
                  value={draft.event}
                  error={errors[ids.event]}
                  onChange={(event) => setEvent(event.target.value as AutomationEventType)}
                  options={eventsOf(kind).map((event) => ({
                    value: event,
                    label: t(`automations.editor.events.${event}`),
                  }))}
                />
                {hasSeconds(draft.event) ? (
                  <TextField
                    id={ids.seconds}
                    label={t(
                      `automations.editor.whenStep.seconds.${draft.event as 'page_view' | 'customer_waiting'}`,
                    )}
                    hint={t('automations.editor.whenStep.secondsHint', {
                      min: EVENT_SECONDS[draft.event].min,
                      max: EVENT_SECONDS[draft.event].max,
                    })}
                    inputMode="numeric"
                    value={draft.seconds}
                    maxLength={4}
                    error={errors[ids.seconds]}
                    onChange={(event) => change({ ...draft, seconds: event.target.value })}
                  />
                ) : null}
              </div>
            </Step>

            <Step
              id="if"
              number={2}
              title={t('automations.editor.ifStep.title')}
              description={t('automations.editor.ifStep.description')}
              aside={
                <span className="text-sm text-text-secondary">
                  {t('automations.editor.ifStep.count', {
                    n: draft.conditions.length,
                    max: MAX_CONDITIONS,
                  })}
                </span>
              }
            >
              <div className="flex flex-col gap-2">
                <span id={`${ids.match}-label`} className="text-sm font-medium text-text">
                  {t('automations.editor.ifStep.match')}
                </span>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={draft.match}
                  aria-labelledby={`${ids.match}-label`}
                  onValueChange={(value) => {
                    if (value === 'all' || value === 'any') change({ ...draft, match: value });
                  }}
                  data-testid="automation-match"
                >
                  {(['all', 'any'] as const).map((match) => (
                    <ToggleGroupItem key={match} id={`${ids.match}-${match}`} value={match}>
                      {t(`automations.editor.ifStep.${match}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <h3 id={ids.conditions} tabIndex={-1} className="sr-only">
                {t('automations.editor.ifStep.title')}
              </h3>
              {errors[ids.conditions] ? (
                <p className="text-sm text-danger">{errors[ids.conditions]}</p>
              ) : null}
              {draft.conditions.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
                  {t('automations.editor.ifStep.empty')}
                </p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {draft.conditions.map((condition, index) => (
                    <li key={condition.key}>
                      <ConditionRow
                        kind={kind}
                        condition={condition}
                        index={index}
                        options={options.data}
                        errors={errors}
                        warning={rowWarning('conditions', index)}
                        onChange={(next) =>
                          change({
                            ...draft,
                            conditions: draft.conditions.map((c) =>
                              c.key === condition.key ? next : c,
                            ),
                          })
                        }
                        onRemove={() => {
                          change({
                            ...draft,
                            conditions: draft.conditions.filter((c) => c.key !== condition.key),
                          });
                          announce(t('automations.editor.ifStep.removed', { number: index + 1 }));
                          focusSoon(ids.addCondition);
                        }}
                      />
                    </li>
                  ))}
                </ol>
              )}
              <ReasonedAction
                reason={
                  conditionsFull
                    ? t('automations.editor.ifStep.full', { max: MAX_CONDITIONS })
                    : null
                }
              >
                <Button
                  id={ids.addCondition}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    const key = freeKey(
                      'c',
                      draft.conditions.map((c) => c.key),
                    );
                    change({
                      ...draft,
                      conditions: [
                        ...draft.conditions,
                        newCondition(nextField(kind, draft.conditions), key),
                      ],
                    });
                    announce(
                      t('automations.editor.ifStep.added', { number: draft.conditions.length + 1 }),
                    );
                    focusSoon(ids.conditionField(key));
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                  {t('automations.editor.ifStep.add')}
                </Button>
              </ReasonedAction>
            </Step>

            <Step
              id="then"
              number={3}
              title={t('automations.editor.thenStep.title')}
              description={t('automations.editor.thenStep.description')}
              aside={
                <span className="text-sm text-text-secondary">
                  {t('automations.editor.thenStep.count', {
                    n: draft.actions.length,
                    max: MAX_ACTIONS,
                  })}
                </span>
              }
            >
              <h3 id={ids.actions} tabIndex={-1} className="sr-only">
                {t('automations.editor.thenStep.title')}
              </h3>
              {ruleWarnings.map((warning) => (
                <Warning key={warning.code}>{warningText(warning.code)}</Warning>
              ))}
              <ol className="flex flex-col gap-3">
                {draft.actions.map((action, index) => (
                  <li key={action.key}>
                    <ActionRow
                      kind={kind}
                      action={action}
                      index={index}
                      options={options.data}
                      errors={errors}
                      warning={rowWarning('actions', index)}
                      onChange={(next) =>
                        change({
                          ...draft,
                          actions: draft.actions.map((a) => (a.key === action.key ? next : a)),
                        })
                      }
                      onRemove={() => {
                        change({
                          ...draft,
                          actions: draft.actions.filter((a) => a.key !== action.key),
                        });
                        announce(t('automations.editor.thenStep.removed', { number: index + 1 }));
                        focusSoon(ids.addAction);
                      }}
                    />
                  </li>
                ))}
              </ol>
              <ReasonedAction
                reason={
                  actionsFull ? t('automations.editor.thenStep.full', { max: MAX_ACTIONS }) : null
                }
              >
                <Button
                  id={ids.addAction}
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  aria-invalid={errors[ids.addAction] ? true : undefined}
                  aria-describedby={errors[ids.addAction] ? `${ids.addAction}-error` : undefined}
                  onClick={() => {
                    const key = freeKey(
                      'a',
                      draft.actions.map((a) => a.key),
                    );
                    change({
                      ...draft,
                      actions: [
                        ...draft.actions,
                        newAction(nextActionType(kind, draft.actions), key),
                      ],
                    });
                    announce(
                      t('automations.editor.thenStep.added', { number: draft.actions.length + 1 }),
                    );
                    focusSoon(ids.actionType(key));
                  }}
                >
                  <PlusIcon aria-hidden="true" />
                  {t('automations.editor.thenStep.add')}
                </Button>
              </ReasonedAction>
              {errors[ids.addAction] ? (
                <p id={`${ids.addAction}-error`} className="text-sm text-danger">
                  {errors[ids.addAction]}
                </p>
              ) : null}
            </Step>

            {warnings.length > 0 ? (
              <div className="flex flex-col gap-2" data-testid="automation-warnings">
                <p className="text-sm font-medium text-text">
                  {t('automations.editor.warnings.title')}
                </p>
                <ul className="flex flex-col gap-1 ps-4 text-sm text-text list-disc">
                  {warnings.map((warning) => (
                    <li key={warning.path.join('.') + warning.code}>{warningText(warning.code)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <ActionError error={failure} />
            <div
              className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
              data-testid="automation-footer"
            >
              <div className="flex flex-wrap items-center gap-3">
                <ReasonedAction reason={reason}>
                  <Button
                    type="submit"
                    variant="secondary"
                    busy={busy === 'save'}
                    disabled={!dirty || busy !== null}
                  >
                    {t('automations.editor.save')}
                  </Button>
                </ReasonedAction>
                <ReasonedAction reason={reason}>
                  <Button
                    type="button"
                    busy={busy === 'publish'}
                    disabled={
                      busy !== null ||
                      (!dirty && base.published !== null && !base.unpublishedChanges)
                    }
                    onClick={() => void publishNow()}
                    data-testid="publish-automation"
                  >
                    {t('automations.editor.publish')}
                  </Button>
                </ReasonedAction>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={!dirty || busy !== null}
                  onClick={() => {
                    setDraft(saved);
                    setServer({});
                    setSummary([]);
                    setAttempted(false);
                  }}
                >
                  {t('automations.editor.reset')}
                </Button>
                {dirty ? (
                  <span className="text-sm text-text-secondary" data-testid="automation-unsaved">
                    {t('automations.editor.unsaved')}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-text-secondary" data-testid="automation-status-line">
                {statusLine()}
              </p>
              <div className="flex items-center gap-3">
                <ReasonedAction reason={reason}>
                  <Switch
                    id="automation-enabled"
                    checked={base.enabled}
                    disabled={toggle.isPending}
                    aria-describedby="automation-enabled-hint"
                    onCheckedChange={async (enabled) => {
                      try {
                        const result = await toggle.mutateAsync(enabled);
                        adopt({ ...result, draft: base.draft, revision: base.revision }, true);
                        announce(
                          enabled
                            ? t('automations.editor.turnedOn', { name })
                            : t('automations.editor.turnedOff', { name }),
                        );
                      } catch (error) {
                        failed(error);
                      }
                    }}
                  />
                </ReasonedAction>
                <div className="flex flex-col">
                  <label htmlFor="automation-enabled" className="text-sm font-medium text-text">
                    {t('automations.editor.enabled')}
                  </label>
                  <span id="automation-enabled-hint" className="text-sm text-text-secondary">
                    {t('automations.editor.enabledHint')}
                  </span>
                </div>
              </div>
            </div>
          </form>
          {wide ? null : tryIt}
          <VersionsPanel
            automation={base}
            restoreReason={reason ?? (dirty ? t('automations.editor.versions.saveFirst') : null)}
            onRestore={async (version) => {
              try {
                const result = await restore.mutateAsync({ version, revision: base.revision });
                adopt(result);
                announce(t('automations.editor.versions.restored', { version }));
              } catch (error) {
                if (isApiError(error, 'VERSION_CONFLICT')) setConflict(true);
                throw error;
              }
            }}
          />
          {kind === 'conversation' ? <RunsPanel automation={base} /> : null}
        </div>
        {wide ? <div className="min-w-0">{tryIt}</div> : null}
      </div>
    </div>
  );
}

/**
 * One automation, full page (G21): its name, "1 When", "2 If", "3 Then", warnings from the same
 * check the gateway makes before publishing, "Try it" beside it, then its versions and (for chat
 * rules) what it did. Saving keeps a draft; publishing makes it run.
 */
export function AutomationEditorPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const { automationId } = useParams({ from: '/_studio/automations/$automationId' });
  const automation = useAutomation(automationId);
  return (
    <QueryState
      query={automation}
      label={t('automations.editor.loading')}
      permitted={can('automations.read')}
      forbidden={
        <div className="flex flex-col gap-6">
          <PageHeader title={t('automations.title')} />
          <Forbidden
            title={t('automations.forbidden.title')}
            description={t('automations.forbidden.description')}
          />
        </div>
      }
    >
      {(data) => <Editor key={data.id} initial={data} />}
    </QueryState>
  );
}
