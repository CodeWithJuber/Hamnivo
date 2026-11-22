import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { TFunction } from 'i18next';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField, ChoiceField, SelectField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { useTeams } from '../../lib/access';
import { isApiError } from '../../lib/api';
import type { ChatTexts } from '../../lib/appearance';
import { DOCS } from '../../lib/docs';
import type { BrandRef } from '../../lib/names';
import { isCancelled } from '../../lib/reauth';
import { useAppearance, type WidgetAppearance } from '../../lib/setup';
import { type ChatLanguage, DEFAULT_FORM_TEXT } from '../../lib/setup-data';
import { useTenant } from '../../lib/tenant';
import type { Team } from '../../lib/types';
import {
  addOption,
  bodyOf,
  controlOfPath,
  DEFAULT_FIELD_LABELS,
  draftOf,
  FIELD_KINDS,
  type FieldDraft,
  type FormName,
  type FormProblem,
  type FormsDraft,
  formIds,
  isDirty,
  isListKind,
  isLockedInOffline,
  LABEL_MAX,
  MAX_FIELDS,
  MAX_OPTIONS,
  MIN_OPTIONS,
  moved,
  newField,
  OFFLINE_WHEN,
  OPTION_LABEL_MAX,
  problemControl,
  problemsOf,
  THANKS_MAX,
  useSaveWidgetForms,
  useWidgetForms,
  type WidgetFormsView,
  widgetFormKeys,
  withKind,
} from '../../lib/widget-forms';
import { LocalizedFields } from '../BrandChatSettings';
import { LeaveGuard } from '../settings/DiscardChangesDialog';
import { firstPreviewLanguage, PreviewColumn } from '../settings/PreviewColumn';
import {
  type PreviewField,
  type PreviewScreen,
  previewLookOf,
  WidgetPreview,
} from '../settings/WidgetPreview';

/** What a problem says, in the language of the page; questions and answers by their number. */
export function problemText(problem: FormProblem, draft: FormsDraft, t: TFunction): string {
  const form = t(`chatWidget.forms.problems.forms.${problem.form}`);
  const at =
    'index' in problem
      ? t('chatWidget.forms.problems.at', { form, number: problem.index + 1 })
      : '';
  const optionNumber = (option: string) =>
    'index' in problem
      ? (draft[problem.form].fields[problem.index]?.options.findIndex((o) => o.id === option) ??
          -1) + 1
      : 0;
  switch (problem.kind) {
    case 'label':
      return t('chatWidget.forms.problems.label', { at });
    case 'duplicateKind':
      return t('chatWidget.forms.problems.duplicateKind', { at });
    case 'fewOptions':
      return t('chatWidget.forms.problems.fewOptions', { at, min: MIN_OPTIONS });
    case 'manyOptions':
      return t('chatWidget.forms.problems.manyOptions', { at, max: MAX_OPTIONS });
    case 'optionLabel':
      return t('chatWidget.forms.problems.optionLabel', {
        at,
        option: optionNumber(problem.option),
      });
    case 'optionTeam':
      return t('chatWidget.forms.problems.optionTeam', {
        at,
        option: optionNumber(problem.option),
      });
    case 'tooManyFields':
      return t('chatWidget.forms.problems.tooManyFields', { form, max: MAX_FIELDS });
    case 'needsEmail':
      return t('chatWidget.forms.problems.needsEmail');
    case 'needsQuestion':
      return t('chatWidget.forms.problems.needsQuestion');
    case 'thanksEnglish':
      return t('chatWidget.forms.problems.thanksEnglish');
  }
}

/** A field's name as people read it: its words in the page's language, else its kind. */
function fieldName(field: FieldDraft, lang: ChatLanguage, t: TFunction): string {
  return (
    field.label[lang].trim() ||
    field.label.en.trim() ||
    t(`chatWidget.forms.fields.kinds.${field.kind}`)
  );
}

/** Puts focus on a control once the change that made it has been drawn. */
const focusSoon = (id: string, fallback?: string) =>
  requestAnimationFrame(() => {
    const target = document.getElementById(id);
    const usable =
      target && !(target as HTMLButtonElement).disabled
        ? target
        : fallback
          ? document.getElementById(fallback)
          : null;
    usable?.focus();
  });

function OptionsEditor({
  form,
  field,
  name,
  teams,
  errors,
  onChange,
}: {
  form: FormName;
  field: FieldDraft;
  name: string;
  teams: readonly Team[] | undefined;
  errors: Record<string, string>;
  onChange: (field: FieldDraft) => void;
}) {
  const { t } = useTranslation();
  const department = field.kind === 'department';
  const full = field.options.length >= MAX_OPTIONS;
  const few = field.options.length <= MIN_OPTIONS;
  const addId = formIds.addOption(form, field.id);
  return (
    <fieldset
      className="flex flex-col gap-3 rounded-lg bg-surface-sunken p-3"
      data-testid="field-options"
    >
      <legend className="px-1 text-sm font-semibold text-text">
        {t('chatWidget.forms.fields.options')}
      </legend>
      <p className="text-sm text-text-secondary">
        {department ? `${t('chatWidget.forms.fields.departmentHint')} ` : null}
        {t('chatWidget.forms.fields.optionsHint', { min: MIN_OPTIONS, max: MAX_OPTIONS })}
      </p>
      {department && teams && !teams.some((team) => team.status === 'active') ? (
        <p className="text-sm text-warning" data-testid="no-teams">
          {t('chatWidget.forms.fields.noTeams')}{' '}
          <Link to="/support-teams" className="underline underline-offset-4 hover:no-underline">
            {t('chatWidget.forms.fields.noTeamsLink')}
          </Link>
        </p>
      ) : null}
      <ol className="flex flex-col gap-3">
        {field.options.map((option, index) => {
          const number = index + 1;
          const labelId = formIds.optionLabel(form, field.id, option.id);
          const teamId = formIds.optionTeam(form, field.id, option.id);
          const update = (patch: Partial<typeof option>) =>
            onChange({
              ...field,
              options: field.options.map((o) => (o.id === option.id ? { ...o, ...patch } : o)),
            });
          return (
            <li
              key={option.id}
              className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3"
            >
              {department ? (
                <SelectField
                  id={teamId}
                  label={t('chatWidget.forms.fields.team', { number })}
                  value={option.teamId}
                  placeholder={t('chatWidget.forms.fields.teamPlaceholder')}
                  error={errors[teamId]}
                  onChange={(event) => update({ teamId: event.target.value })}
                  // Active teams, and the one already chosen even if it was archived since.
                  options={(teams ?? [])
                    .filter((team) => team.status === 'active' || team.id === option.teamId)
                    .map((team) => ({ value: team.id, label: team.name }))}
                />
              ) : null}
              <LocalizedFields
                id={labelId}
                legend={t('chatWidget.forms.fields.option', { number })}
                value={option.label}
                maxLength={OPTION_LABEL_MAX}
                others={(n) => t('chatWidget.forms.fields.otherLanguages', { n })}
                error={errors[`${labelId}-en`]}
                onChange={(label) => update({ label })}
              />
              {/* A list keeps its fewest answers (the hint above says how many). */}
              {few ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    onChange({
                      ...field,
                      options: field.options.filter((o) => o.id !== option.id),
                    });
                    focusSoon(addId);
                  }}
                >
                  <Trash2Icon aria-hidden="true" />
                  {t('chatWidget.forms.fields.removeOption', { number, name })}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      <ReasonedAction
        reason={full ? t('chatWidget.forms.fields.optionsFull', { max: MAX_OPTIONS }) : null}
      >
        <Button
          id={addId}
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          aria-invalid={errors[addId] ? true : undefined}
          aria-describedby={errors[addId] ? `${addId}-error` : undefined}
          onClick={() => {
            const next = addOption(field);
            onChange(next);
            const added = next.options[next.options.length - 1];
            if (added) {
              focusSoon(
                department
                  ? formIds.optionTeam(form, field.id, added.id)
                  : `${formIds.optionLabel(form, field.id, added.id)}-en`,
              );
            }
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t('chatWidget.forms.fields.addOption')}
        </Button>
      </ReasonedAction>
      {errors[addId] ? (
        <p id={`${addId}-error`} className="text-sm text-danger">
          {errors[addId]}
        </p>
      ) : null}
    </fieldset>
  );
}

const FieldRow = memo(function FieldRow({
  form,
  field,
  index,
  count,
  teams,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  form: FormName;
  field: FieldDraft;
  index: number;
  count: number;
  teams: readonly Team[] | undefined;
  errors: Record<string, string>;
  onChange: (field: FieldDraft) => void;
  onMove: (field: FieldDraft, by: -1 | 1) => void;
  onRemove: (field: FieldDraft) => void;
}) {
  const { t, i18n } = useTranslation();
  const name = fieldName(field, firstPreviewLanguage(i18n.language), t);
  const locked = isLockedInOffline(form, field);
  const kindId = formIds.kind(form, field.id);
  const labelId = formIds.label(form, field.id);
  const upId = `${formIds.field(form, field.id)}-up`;
  const downId = `${formIds.field(form, field.id)}-down`;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3"
      data-testid={`${form}-field`}
      data-field={field.id}
      data-kind={field.kind}
    >
      <legend className="px-1 text-sm font-semibold text-text">
        <bdi>{t('chatWidget.forms.fields.field', { number: index + 1, name })}</bdi>
      </legend>
      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <SelectField
          id={kindId}
          label={t('chatWidget.forms.fields.kind')}
          value={field.kind}
          error={errors[kindId]}
          onChange={(event) => onChange(withKind(field, event.target.value as FieldDraft['kind']))}
          options={FIELD_KINDS.map((kind) => ({
            value: kind,
            label: t(`chatWidget.forms.fields.kinds.${kind}`),
          }))}
        />
        <div className="pb-2">
          <CheckboxField
            id={formIds.required(form, field.id)}
            label={t('chatWidget.forms.fields.required')}
            checked={locked || field.required}
            disabled={locked}
            hint={
              locked
                ? field.kind === 'email'
                  ? t('chatWidget.forms.offline.emailLocked')
                  : t('chatWidget.forms.offline.questionLocked')
                : undefined
            }
            onCheckedChange={(required) => onChange({ ...field, required })}
          />
        </div>
      </div>
      <LocalizedFields
        id={labelId}
        legend={t('chatWidget.forms.fields.label')}
        hint={t('chatWidget.forms.fields.labelHint')}
        value={field.label}
        maxLength={LABEL_MAX}
        others={(n) => t('chatWidget.forms.fields.otherLanguages', { n })}
        error={errors[`${labelId}-en`]}
        onChange={(label) => onChange({ ...field, label })}
      />
      {isListKind(field.kind) ? (
        <OptionsEditor
          form={form}
          field={field}
          name={name}
          teams={teams}
          errors={errors}
          onChange={onChange}
        />
      ) : null}
      <div className="flex flex-wrap items-start gap-2">
        <Button
          id={upId}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('chatWidget.forms.fields.moveUp', { name })}
          disabled={index === 0}
          onClick={() => {
            onMove(field, -1);
            focusSoon(upId, downId);
          }}
        >
          <ArrowUpIcon aria-hidden="true" />
        </Button>
        <Button
          id={downId}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t('chatWidget.forms.fields.moveDown', { name })}
          disabled={index === count - 1}
          onClick={() => {
            onMove(field, 1);
            focusSoon(downId, upId);
          }}
        >
          <ArrowDownIcon aria-hidden="true" />
        </Button>
        <ReasonedAction reason={locked ? t('chatWidget.forms.offline.lockedRemove') : null}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={t('chatWidget.forms.fields.remove', { name })}
            onClick={() => onRemove(field)}
          >
            <Trash2Icon aria-hidden="true" />
            {t('chatWidget.forms.fields.removeShort')}
          </Button>
        </ReasonedAction>
      </div>
    </fieldset>
  );
});

/**
 * The questions of one form: their order, kind, words and answers. Memoized: a key pressed in one
 * form redraws only that form's questions (with `onChange` and `errors` kept stable by the editor).
 */
const FieldListEditor = memo(function FieldListEditor({
  form,
  fields,
  teams,
  errors,
  onChange,
}: {
  form: FormName;
  fields: FieldDraft[];
  teams: readonly Team[] | undefined;
  errors: Record<string, string>;
  onChange: (fields: FieldDraft[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const announce = useAnnouncer();
  const lang = firstPreviewLanguage(i18n.language);
  const listId = formIds.fields(form);
  const full = fields.length >= MAX_FIELDS;
  // One set of callbacks for every row, reading the latest list: a row that did not redraw still
  // changes the list as it is now, not as it was when that row last drew.
  const latest = useRef({ fields, onChange });
  useLayoutEffect(() => {
    latest.current = { fields, onChange };
  });
  const changeField = useCallback((next: FieldDraft) => {
    const { fields: now, onChange: change } = latest.current;
    change(now.map((f) => (f.id === next.id ? next : f)));
  }, []);
  const moveField = useCallback(
    (field: FieldDraft, by: -1 | 1) => {
      const { fields: now, onChange: change } = latest.current;
      const index = now.findIndex((f) => f.id === field.id);
      change(moved(now, index, by));
      announce(
        t('chatWidget.forms.fields.moved', {
          name: fieldName(field, lang, t),
          number: index + 1 + by,
        }),
      );
    },
    [announce, lang, t],
  );
  const removeField = useCallback(
    (field: FieldDraft) => {
      const { fields: now, onChange: change } = latest.current;
      change(now.filter((f) => f.id !== field.id));
      announce(t('chatWidget.forms.fields.removed', { name: fieldName(field, lang, t) }));
      focusSoon(listId);
    },
    [announce, lang, listId, t],
  );
  return (
    <div className="flex flex-col gap-3" data-testid={`${form}-fields`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={listId} tabIndex={-1} className="text-base font-semibold text-text">
          {t('chatWidget.forms.fields.legend')}
        </h3>
        <span className="text-sm text-text-secondary">
          {t('chatWidget.forms.fields.count', { n: fields.length, max: MAX_FIELDS })}
        </span>
      </div>
      {errors[listId] ? (
        <p className="text-sm text-danger" data-testid={`${form}-fields-error`}>
          {errors[listId]}
        </p>
      ) : null}
      {fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
          {t('chatWidget.forms.fields.empty')}
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {fields.map((field, index) => (
            <li key={field.id}>
              <FieldRow
                form={form}
                field={field}
                index={index}
                count={fields.length}
                teams={teams}
                errors={errors}
                onChange={changeField}
                onMove={moveField}
                onRemove={removeField}
              />
            </li>
          ))}
        </ol>
      )}
      <ReasonedAction reason={full ? t('chatWidget.forms.fields.full', { max: MAX_FIELDS }) : null}>
        <Button
          id={formIds.addField(form)}
          type="button"
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => {
            const added = newField(fields);
            onChange([...fields, added]);
            announce(t('chatWidget.forms.fields.added', { name: fieldName(added, lang, t) }));
            focusSoon(formIds.kind(form, added.id));
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t('chatWidget.forms.fields.add')}
        </Button>
      </ReasonedAction>
    </div>
  );
});

const texts = (value: ChatTexts, lang: ChatLanguage, fallback: string) =>
  value[lang].trim() || value.en.trim() || fallback;

/** The fields of a form as the customer reads them in one language. */
export function previewFields(fields: readonly FieldDraft[], lang: ChatLanguage): PreviewField[] {
  return fields.map((field) => ({
    id: field.id,
    kind: field.kind,
    label: texts(field.label, lang, DEFAULT_FIELD_LABELS[field.kind][lang]),
    required: field.required,
    options: isListKind(field.kind)
      ? field.options.map((option) => texts(option.label, lang, '…'))
      : [],
  }));
}

/** No messages yet: one object, so the memoized question lists see no change. */
const NO_ERRORS: Record<string, string> = {};

function FormsEditor({
  brand,
  view,
  appearance,
  teams,
  onDirtyChange,
}: {
  brand: BrandRef;
  view: WidgetFormsView;
  appearance: WidgetAppearance | undefined;
  teams: readonly Team[] | undefined;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const save = useSaveWidgetForms(brand.id);
  const saved = useMemo(() => draftOf(view.forms), [view]);
  const [draft, setDraft] = useState<FormsDraft>(saved);
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<ChatLanguage>(() => firstPreviewLanguage(i18n.language));
  const [screen, setScreen] = useState<PreviewScreen>('prechat');
  const editable = can('widget.configure');
  const dirty = isDirty(draft, saved);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const change = (next: FormsDraft) => {
    setDraft(next);
    setServer({});
  };
  const setPrechat = (patch: Partial<FormsDraft['prechat']>) =>
    change({ ...draft, prechat: { ...draft.prechat, ...patch } });
  const setOffline = (patch: Partial<FormsDraft['offline']>) =>
    change({ ...draft, offline: { ...draft.offline, ...patch } });
  // Stable, and from the latest draft, so the other form's question list need not redraw.
  const setPrechatFields = useCallback((fields: FieldDraft[]) => {
    setDraft((current) => ({ ...current, prechat: { ...current.prechat, fields } }));
    setServer({});
  }, []);
  const setOfflineFields = useCallback((fields: FieldDraft[]) => {
    setDraft((current) => ({ ...current, offline: { ...current.offline, fields } }));
    setServer({});
  }, []);

  const problems = problemsOf(draft);
  // One message per control: the checks here first, then what the gateway said.
  const messages = new Map<string, string>();
  for (const problem of problems) {
    const id = problemControl(problem);
    const text = problemText(problem, draft, t);
    messages.set(id, messages.has(id) ? `${messages.get(id)} ${text}` : text);
  }
  for (const [id, text] of Object.entries(server)) if (!messages.has(id)) messages.set(id, text);
  // By the fields, the messages follow the changes; the summary is what the last Save found, so
  // it does not take focus away while a field is being put right.
  const errors: Record<string, string> = attempted ? Object.fromEntries(messages) : NO_ERRORS;
  const [summary, setSummary] = useState<{ fieldId: string; message: string }[]>([]);
  const listOf = (entries: Map<string, string> | Record<string, string>) =>
    [...(entries instanceof Map ? entries : Object.entries(entries))].map(([fieldId, message]) => ({
      fieldId,
      message,
    }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setServer({});
    if (problems.length > 0) {
      setSummary(listOf(messages));
      return;
    }
    setSummary([]);
    try {
      const result = await save.mutateAsync(bodyOf(draft));
      // What was saved is the new starting point at once, without waiting for a reload.
      client.setQueryData([tenantId, ...widgetFormKeys.forms(brand.id)], result);
      announce(t('chatWidget.forms.saved', { name: brand.name }));
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          const id = controlOfPath(field.path, draft);
          fields[id] = fields[id] ? `${fields[id]} ${field.message}` : field.message;
        }
        setServer(fields);
        setSummary(listOf(fields));
      }
    }
  };

  const look = previewLookOf(appearance, brand.name, lang);
  const notice =
    screen === 'prechat' && !draft.prechat.enabled
      ? t('chatWidget.preview.prechatOff')
      : (screen === 'offline' || screen === 'thanks') && !draft.offline.enabled
        ? t('chatWidget.preview.offlineOff')
        : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <form
        className="flex min-w-0 flex-col gap-6"
        onSubmit={submit}
        noValidate
        data-testid="forms-form"
      >
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <p>
          <GuideLink href={DOCS.setup.chatWidgetForms}>{t('chatWidget.forms.guide')}</GuideLink>
        </p>
        <div onFocusCapture={() => setScreen('prechat')}>
          <Section
            id={formIds.section('prechat')}
            title={t('chatWidget.forms.prechat.title')}
            description={t('chatWidget.forms.prechat.description')}
          >
            <CheckboxField
              id={formIds.enabled('prechat')}
              label={t('chatWidget.forms.prechat.enabled')}
              hint={t('chatWidget.forms.prechat.enabledHint')}
              checked={draft.prechat.enabled}
              onCheckedChange={(enabled) => setPrechat({ enabled })}
            />
            <CheckboxField
              id={formIds.skipVerified}
              label={t('chatWidget.forms.prechat.skipVerified')}
              hint={t('chatWidget.forms.prechat.skipVerifiedHint')}
              checked={draft.prechat.skipVerified}
              onCheckedChange={(skipVerified) => setPrechat({ skipVerified })}
            />
            <FieldListEditor
              form="prechat"
              fields={draft.prechat.fields}
              teams={teams}
              errors={errors}
              onChange={setPrechatFields}
            />
          </Section>
        </div>
        <div
          onFocusCapture={(event) =>
            setScreen(
              (event.target as HTMLElement).id.startsWith(formIds.thanks) ? 'thanks' : 'offline',
            )
          }
        >
          <Section
            id={formIds.section('offline')}
            title={t('chatWidget.forms.offline.title')}
            description={t('chatWidget.forms.offline.description')}
          >
            <CheckboxField
              id={formIds.enabled('offline')}
              label={t('chatWidget.forms.offline.enabled')}
              hint={t('chatWidget.forms.offline.enabledHint')}
              checked={draft.offline.enabled}
              onCheckedChange={(enabled) => setOffline({ enabled })}
            />
            <ChoiceField
              id={formIds.when}
              legend={t('chatWidget.forms.offline.when')}
              value={draft.offline.when}
              onValueChange={(when) => setOffline({ when: when as FormsDraft['offline']['when'] })}
              error={errors[`${formIds.when}-${draft.offline.when}`]}
              choices={OFFLINE_WHEN.map((when) => ({
                value: when,
                label: t(`chatWidget.forms.offline.whens.${when}`),
                hint: t(`chatWidget.forms.offline.whens.${when}Hint`),
              }))}
            />
            <FieldListEditor
              form="offline"
              fields={draft.offline.fields}
              teams={teams}
              errors={errors}
              onChange={setOfflineFields}
            />
            <LocalizedFields
              id={formIds.thanks}
              legend={t('chatWidget.forms.offline.thanks')}
              hint={t('chatWidget.forms.offline.thanksHint')}
              value={draft.offline.thanks}
              maxLength={THANKS_MAX}
              multiline
              placeholders={draft.offline.thanks.en.trim() ? {} : { ...DEFAULT_FORM_TEXT.thanks }}
              error={errors[`${formIds.thanks}-en`]}
              onChange={(thanks) => setOffline({ thanks })}
            />
            <CheckboxField
              id={formIds.aiFirst}
              label={t('chatWidget.forms.offline.aiFirst')}
              hint={t('chatWidget.forms.offline.aiFirstHint')}
              checked={draft.offline.aiFirst}
              onCheckedChange={(aiFirst) => setOffline({ aiFirst })}
            />
          </Section>
        </div>
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        {isCancelled(save.error) ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <ReasonedAction reason={editable ? null : t('chatWidget.noPermission')}>
            <Button type="submit" busy={save.isPending} disabled={!dirty}>
              {t('chatWidget.forms.save')}
            </Button>
          </ReasonedAction>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(saved);
              setServer({});
              setSummary([]);
              setAttempted(false);
            }}
          >
            {t('chatWidget.reset')}
          </Button>
          {dirty ? (
            <span className="text-sm text-text-secondary" data-testid="forms-unsaved">
              {t('chatWidget.unsaved')}
            </span>
          ) : null}
        </div>
      </form>
      <PreviewColumn
        id="forms-preview"
        lang={lang}
        onLangChange={setLang}
        screen={screen}
        onScreenChange={(value) => setScreen(value as PreviewScreen)}
        screens={(['prechat', 'offline', 'thanks'] as const).map((value) => ({
          value,
          label: t(`chatWidget.preview.screens.${value}`),
        }))}
        notice={notice}
      >
        <WidgetPreview
          look={look}
          screen={screen}
          content={{
            fields: previewFields(
              screen === 'prechat' ? draft.prechat.fields : draft.offline.fields,
              lang,
            ),
            thanks: texts(draft.offline.thanks, lang, DEFAULT_FORM_TEXT.thanks[lang]),
          }}
        />
      </PreviewColumn>
    </div>
  );
}

/** The pre-chat form (W26) and the contact form for when nobody can answer (W11). */
export function FormsTab({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const forms = useWidgetForms(brand.id);
  const appearance = useAppearance(brand.id);
  const teams = useTeams();
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="forms-tab">
      <LeaveGuard dirty={dirty} />
      <QueryState query={forms} label={t('chatWidget.loading')}>
        {(view) => (
          <FormsEditor
            key={`${brand.id}-${view.configVersion}-${view.updatedAt ?? 'new'}`}
            brand={brand}
            view={view}
            appearance={appearance.data?.appearance}
            teams={teams.data?.items}
            onDirtyChange={setDirty}
          />
        )}
      </QueryState>
    </div>
  );
}
