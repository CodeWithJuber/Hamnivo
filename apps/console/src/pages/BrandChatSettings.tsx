import type * as C from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { FieldDescription, FieldLegend, FieldSet } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../components/AppDialog';
import { CheckboxField, ChoiceField, SelectField, TextField } from '../components/Fields';
import { ActionError, QueryState } from '../components/States';
import { api } from '../lib/api';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import type { Brand } from '../lib/types';

/**
 * A brand's chat settings (widget.configure: W02 layout, W09 files, W17 help, W23 deletion, W25
 * emails) and its proactive prompts (widget.proactive, W19), each in its own dialog. The gateway
 * checks every value again; the limits here only say early what it would refuse.
 */

type Settings = C.WidgetSettings;
type Proactive = C.ProactiveSettings;
export type Lang = 'en' | 'ar' | 'hi' | 'ur';
export const LANGS: Lang[] = ['en', 'ar', 'hi', 'ur'];
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'] as const;
const TYPE_KEYS = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
} as const;
const MODES = ['bubble', 'panel', 'inline', 'fullpage'] as const;
const KINDS = ['page_path', 'time_on_page', 'returning_visitor'] as const;

export type Texts = Record<Lang, string>;
export const texts = (value?: Partial<Record<Lang, string>>): Texts => ({
  en: value?.en ?? '',
  ar: value?.ar ?? '',
  hi: value?.hi ?? '',
  ur: value?.ur ?? '',
});
/** English plus the languages filled in; an empty one falls back to English in the chat. */
export const localized = (value: Texts) =>
  Object.fromEntries(
    LANGS.flatMap((lang) => (value[lang].trim() ? [[lang, value[lang].trim()]] : [])),
  ) as C.LocalizedText;

/** A whole number within bounds, or null. */
function whole(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

const settingsPath = (brand: Brand) => `/v1/admin/brands/${brand.id}/widget-settings`;
const proactivePath = (brand: Brand) => `/v1/admin/brands/${brand.id}/proactive`;

/** One text per language, English first and required. */
export function LocalizedFields({
  id,
  legend,
  hint,
  value,
  maxLength,
  error,
  onChange,
}: {
  id: string;
  legend: string;
  hint?: string;
  value: Texts;
  maxLength: number;
  error?: string | undefined;
  onChange: (value: Texts) => void;
}) {
  const { t } = useTranslation();
  return (
    <FieldSet className="gap-3 rounded-lg border border-border p-3">
      <FieldLegend variant="label" className="mb-0">
        {legend}
      </FieldLegend>
      {hint ? <FieldDescription className="mt-0">{hint}</FieldDescription> : null}
      {LANGS.map((lang) => (
        <TextField
          key={lang}
          id={`${id}-${lang}`}
          label={t(`chatSettings.languages.${lang}`)}
          lang={lang}
          dir="auto"
          value={value[lang]}
          maxLength={maxLength}
          error={lang === 'en' ? error : undefined}
          onChange={(event) => onChange({ ...value, [lang]: event.target.value })}
        />
      ))}
    </FieldSet>
  );
}

interface SettingsDraft {
  mode: Settings['layout']['mode'];
  position: Settings['layout']['position'];
  files: boolean;
  types: string[];
  maxMegabytes: string;
  maxFiles: string;
  search: boolean;
  suggestions: Texts[];
  deleteMinutes: string;
  emails: boolean;
}

const settingsDraft = (s: Settings): SettingsDraft => ({
  mode: s.layout.mode,
  position: s.layout.position,
  files: s.attachments.enabled,
  types: [...s.attachments.allowedTypes],
  maxMegabytes: String(s.attachments.maxMegabytes),
  maxFiles: String(s.attachments.maxFiles),
  search: s.help.search,
  suggestions: s.help.suggestions.map((q) => texts(q)),
  deleteMinutes: String(s.deletion.windowMinutes),
  emails: s.notifications.email,
});

function SettingsForm({
  brand,
  initial,
  onDone,
}: {
  brand: Brand;
  initial: Settings;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [draft, setDraft] = useState(() => settingsDraft(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const save = useStudioMutation(
    (body: Settings, tenant) =>
      api<C.WidgetSettingsView>(settingsPath(brand), { method: 'PUT', body, tenant }),
    [['widget-settings', brand.id]],
  );
  const set = (patch: Partial<SettingsDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    const maxMegabytes = whole(draft.maxMegabytes, 1, 10);
    const maxFiles = whole(draft.maxFiles, 1, 5);
    const minutes = whole(draft.deleteMinutes, 0, 60);
    if (maxMegabytes === null)
      next.maxMegabytes = t('chatSettings.invalidNumber', { min: 1, max: 10 });
    if (maxFiles === null) next.maxFiles = t('chatSettings.invalidNumber', { min: 1, max: 5 });
    if (minutes === null) next.deletion = t('chatSettings.invalidNumber', { min: 0, max: 60 });
    if (draft.files && draft.types.length === 0) next.types = t('chatSettings.files.typesRequired');
    draft.suggestions.forEach((q, index) => {
      if (!q.en.trim())
        next[`suggestion-${index}`] = t('chatSettings.help.required', { number: index + 1 });
    });
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await save.mutateAsync({
        layout: { mode: draft.mode, position: draft.position },
        attachments: {
          enabled: draft.files,
          allowedTypes: (draft.types.length
            ? draft.types
            : [...TYPES]) as Settings['attachments']['allowedTypes'],
          maxMegabytes: maxMegabytes as number,
          maxFiles: maxFiles as number,
        },
        help: { search: draft.search, suggestions: draft.suggestions.map(localized) },
        deletion: { windowMinutes: minutes as number },
        notifications: { email: draft.emails },
      });
      announce(t('chatSettings.saved', { name: brand.name }));
      onDone();
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: field.startsWith('suggestion-')
          ? `chat-${field}-en`
          : field === 'types'
            ? `chat-type-${TYPE_KEYS['image/png']}`
            : `chat-${field}`,
        message,
      }))
    : [];

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={submit}
      noValidate
      data-testid="chat-settings-form"
    >
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <ChoiceField
        id="chat-mode"
        legend={t('chatSettings.layout.legend')}
        hint={t('chatSettings.layout.note')}
        value={draft.mode}
        onValueChange={(mode) => set({ mode: mode as SettingsDraft['mode'] })}
        choices={MODES.map((mode) => ({
          value: mode,
          label: t(`chatSettings.layout.${mode}`),
          hint: t(`chatSettings.layout.${mode}Hint`),
        }))}
      />
      <SelectField
        id="chat-position"
        label={t('chatSettings.layout.side')}
        value={draft.position}
        onChange={(event) => set({ position: event.target.value as SettingsDraft['position'] })}
        options={[
          { value: 'bottom-right', label: t('chatSettings.layout.right') },
          { value: 'bottom-left', label: t('chatSettings.layout.left') },
        ]}
      />
      <FieldSet className="gap-3">
        <FieldLegend variant="label" className="mb-0">
          {t('chatSettings.files.legend')}
        </FieldLegend>
        <CheckboxField
          id="chat-files"
          label={t('chatSettings.files.enabled')}
          hint={t('chatSettings.files.enabledHint')}
          checked={draft.files}
          onCheckedChange={(files) => set({ files })}
        />
        {draft.files ? (
          <>
            <FieldSet className="gap-2">
              <FieldLegend variant="label" className="mb-0 text-sm">
                {t('chatSettings.files.types')}
              </FieldLegend>
              {TYPES.map((type) => (
                <CheckboxField
                  key={type}
                  id={`chat-type-${TYPE_KEYS[type]}`}
                  label={t(`chatSettings.files.${TYPE_KEYS[type]}`)}
                  checked={draft.types.includes(type)}
                  onCheckedChange={(on) =>
                    set({
                      types: on
                        ? [...draft.types, type]
                        : draft.types.filter((value) => value !== type),
                    })
                  }
                />
              ))}
              {errors.types ? (
                <p className="text-sm text-danger" role="alert">
                  {errors.types}
                </p>
              ) : null}
            </FieldSet>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                id="chat-maxMegabytes"
                label={t('chatSettings.files.maxMegabytes')}
                hint={t('chatSettings.files.maxMegabytesHint')}
                inputMode="numeric"
                value={draft.maxMegabytes}
                error={errors.maxMegabytes}
                onChange={(event) => set({ maxMegabytes: event.target.value })}
              />
              <TextField
                id="chat-maxFiles"
                label={t('chatSettings.files.maxFiles')}
                hint={t('chatSettings.files.maxFilesHint')}
                inputMode="numeric"
                value={draft.maxFiles}
                error={errors.maxFiles}
                onChange={(event) => set({ maxFiles: event.target.value })}
              />
            </div>
          </>
        ) : null}
      </FieldSet>
      <FieldSet className="gap-3">
        <FieldLegend variant="label" className="mb-0">
          {t('chatSettings.help.legend')}
        </FieldLegend>
        <CheckboxField
          id="chat-search"
          label={t('chatSettings.help.search')}
          checked={draft.search}
          onCheckedChange={(search) => set({ search })}
        />
        <p className="text-sm text-text-secondary">{t('chatSettings.help.suggestionsHint')}</p>
        {draft.suggestions.map((question, index) => (
          // Questions have no ids of their own; their place is what the form shows.
          // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here
          <div key={index} className="flex flex-col gap-2">
            <LocalizedFields
              id={`chat-suggestion-${index}`}
              legend={t('chatSettings.help.question', { number: index + 1 })}
              value={question}
              maxLength={120}
              error={errors[`suggestion-${index}`]}
              onChange={(value) =>
                set({
                  suggestions: draft.suggestions.map((q, i) => (i === index ? value : q)),
                })
              }
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => set({ suggestions: draft.suggestions.filter((_, i) => i !== index) })}
            >
              <Trash2Icon aria-hidden="true" />
              {t('chatSettings.help.remove', { number: index + 1 })}
            </Button>
          </div>
        ))}
        {draft.suggestions.length < 6 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => set({ suggestions: [...draft.suggestions, texts()] })}
          >
            <PlusIcon aria-hidden="true" />
            {t('chatSettings.help.add')}
          </Button>
        ) : null}
      </FieldSet>
      <TextField
        id="chat-deletion"
        label={t('chatSettings.deletion.label')}
        hint={t('chatSettings.deletion.hint')}
        inputMode="numeric"
        value={draft.deleteMinutes}
        error={errors.deletion}
        onChange={(event) => set({ deleteMinutes: event.target.value })}
      />
      <CheckboxField
        id="chat-emails"
        label={t('chatSettings.emails.label')}
        hint={t('chatSettings.emails.hint')}
        checked={draft.emails}
        onCheckedChange={(emails) => set({ emails })}
      />
      <ActionError error={save.error} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={save.isPending}>
          {t('chatSettings.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ChatSettingsDialog({
  brand,
  open,
  onOpenChange,
}: {
  brand: Brand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const query = useStudioQuery<C.WidgetSettingsView>(
    ['widget-settings', brand.id],
    settingsPath(brand),
    { enabled: open },
  );
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('chatSettings.title', { name: brand.name })}
      description={t('chatSettings.description')}
      className="sm:max-w-2xl"
      testId="chat-settings-dialog"
    >
      <QueryState query={query} label={t('chatSettings.loading')}>
        {(data) => (
          <SettingsForm
            key={`${data.configVersion}`}
            brand={brand}
            initial={data.settings}
            onDone={() => onOpenChange(false)}
          />
        )}
      </QueryState>
    </AppDialog>
  );
}

interface TriggerDraft {
  id: string;
  kind: C.ProactiveTrigger['kind'];
  path: string;
  seconds: string;
  visits: string;
  message: Texts;
}

const triggerDraft = (trigger: C.ProactiveTrigger): TriggerDraft => ({
  id: trigger.id,
  kind: trigger.kind,
  path: trigger.path ?? '',
  seconds: String(trigger.seconds),
  visits: trigger.visits === null ? '' : String(trigger.visits),
  message: texts(trigger.message),
});

function ProactiveForm({
  brand,
  initial,
  onDone,
}: {
  brand: Brand;
  initial: Proactive;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [maxPerDay, setMaxPerDay] = useState(String(initial.maxPerDay));
  const [dismissHours, setDismissHours] = useState(String(initial.dismissHours));
  const [onlyWhenAvailable, setOnlyWhenAvailable] = useState(initial.onlyWhenAvailable);
  const [triggers, setTriggers] = useState(() => initial.triggers.map(triggerDraft));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const save = useStudioMutation(
    (body: Proactive, tenant) =>
      api<C.ProactiveSettingsView>(proactivePath(brand), { method: 'PUT', body, tenant }),
    [['proactive', brand.id]],
  );
  const change = (index: number, patch: Partial<TriggerDraft>) =>
    setTriggers((all) =>
      all.map((trigger, i) => (i === index ? { ...trigger, ...patch } : trigger)),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    const perDay = whole(maxPerDay, 1, 3);
    const hours = whole(dismissHours, 1, 168);
    if (perDay === null) next.maxPerDay = t('chatSettings.invalidNumber', { min: 1, max: 3 });
    if (hours === null) next.dismissHours = t('chatSettings.invalidNumber', { min: 1, max: 168 });
    const seen = new Set<string>();
    const built = triggers.map((trigger, index) => {
      const number = index + 1;
      const id = trigger.id.trim();
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
        next[`trigger-${index}-id`] = t('chatSettings.proactive.idInvalid', { number });
      else if (seen.has(id))
        next[`trigger-${index}-id`] = t('chatSettings.proactive.idDuplicate', { number });
      seen.add(id);
      const path = trigger.path.trim();
      if (trigger.kind === 'page_path' && !path)
        next[`trigger-${index}-path`] = t('chatSettings.proactive.pathRequired', { number });
      else if (path && !/^\/[^\s?#]{0,200}$/.test(path))
        next[`trigger-${index}-path`] = t('chatSettings.proactive.pathInvalid', { number });
      const minSeconds = trigger.kind === 'time_on_page' ? 10 : 0;
      const seconds = whole(trigger.seconds, minSeconds, 600);
      if (seconds === null)
        next[`trigger-${index}-seconds`] = t('chatSettings.invalidNumber', {
          min: minSeconds,
          max: 600,
        });
      const visits = trigger.kind === 'returning_visitor' ? whole(trigger.visits, 2, 20) : null;
      if (trigger.kind === 'returning_visitor' && visits === null)
        next[`trigger-${index}-visits`] = t('chatSettings.invalidNumber', { min: 2, max: 20 });
      if (!trigger.message.en.trim())
        next[`trigger-${index}-message`] = t('chatSettings.proactive.messageRequired', { number });
      return {
        id,
        kind: trigger.kind,
        path: path || null,
        seconds: seconds ?? 0,
        visits,
        message: localized(trigger.message),
      };
    });
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    try {
      await save.mutateAsync({
        enabled,
        maxPerDay: perDay as number,
        dismissHours: hours as number,
        onlyWhenAvailable,
        triggers: built,
      });
      announce(t('chatSettings.proactive.saved', { name: brand.name }));
      onDone();
    } catch {
      // Shown below the form.
    }
  };

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({
        fieldId: field.startsWith('trigger-')
          ? `proactive-${field}${field.endsWith('-message') ? '-en' : ''}`
          : `proactive-${field}`,
        message,
      }))
    : [];

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate data-testid="proactive-form">
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <CheckboxField
        id="proactive-enabled"
        label={t('chatSettings.proactive.enabled')}
        hint={t('chatSettings.proactive.enabledHint')}
        checked={enabled}
        onCheckedChange={setEnabled}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="proactive-maxPerDay"
          label={t('chatSettings.proactive.maxPerDay')}
          hint={t('chatSettings.proactive.maxPerDayHint')}
          inputMode="numeric"
          value={maxPerDay}
          error={errors.maxPerDay}
          onChange={(event) => setMaxPerDay(event.target.value)}
        />
        <TextField
          id="proactive-dismissHours"
          label={t('chatSettings.proactive.dismissHours')}
          hint={t('chatSettings.proactive.dismissHoursHint')}
          inputMode="numeric"
          value={dismissHours}
          error={errors.dismissHours}
          onChange={(event) => setDismissHours(event.target.value)}
        />
      </div>
      <CheckboxField
        id="proactive-onlyWhenAvailable"
        label={t('chatSettings.proactive.onlyWhenAvailable')}
        hint={t('chatSettings.proactive.onlyWhenAvailableHint')}
        checked={onlyWhenAvailable}
        onCheckedChange={setOnlyWhenAvailable}
      />
      <FieldSet className="gap-4">
        <FieldLegend variant="label" className="mb-0">
          {t('chatSettings.proactive.prompts')}
        </FieldLegend>
        <FieldDescription className="mt-0">
          {t('chatSettings.proactive.promptsHint')}
        </FieldDescription>
        {triggers.map((trigger, index) => {
          const number = index + 1;
          const id = `proactive-trigger-${index}`;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here
            <FieldSet key={index} className="gap-3 rounded-lg border border-border p-3">
              <FieldLegend variant="label" className="mb-0">
                {t('chatSettings.proactive.prompt', { number })}
              </FieldLegend>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id={`${id}-id`}
                  label={t('chatSettings.proactive.id')}
                  hint={t('chatSettings.proactive.idHint')}
                  dir="ltr"
                  value={trigger.id}
                  maxLength={32}
                  error={errors[`trigger-${index}-id`]}
                  onChange={(event) => change(index, { id: event.target.value })}
                />
                <SelectField
                  id={`${id}-kind`}
                  label={t('chatSettings.proactive.kind')}
                  value={trigger.kind}
                  onChange={(event) =>
                    change(index, { kind: event.target.value as TriggerDraft['kind'] })
                  }
                  options={KINDS.map((kind) => ({
                    value: kind,
                    label: t(`chatSettings.proactive.kinds.${kind}`),
                  }))}
                />
                <TextField
                  id={`${id}-path`}
                  label={t('chatSettings.proactive.path')}
                  hint={
                    trigger.kind === 'page_path'
                      ? t('chatSettings.proactive.pathHint')
                      : t('chatSettings.proactive.pathOptionalHint')
                  }
                  dir="ltr"
                  value={trigger.path}
                  maxLength={201}
                  error={errors[`trigger-${index}-path`]}
                  onChange={(event) => change(index, { path: event.target.value })}
                />
                <TextField
                  id={`${id}-seconds`}
                  label={t('chatSettings.proactive.seconds')}
                  hint={t('chatSettings.proactive.secondsHint')}
                  inputMode="numeric"
                  value={trigger.seconds}
                  error={errors[`trigger-${index}-seconds`]}
                  onChange={(event) => change(index, { seconds: event.target.value })}
                />
                {trigger.kind === 'returning_visitor' ? (
                  <TextField
                    id={`${id}-visits`}
                    label={t('chatSettings.proactive.visits')}
                    hint={t('chatSettings.proactive.visitsHint')}
                    inputMode="numeric"
                    value={trigger.visits}
                    error={errors[`trigger-${index}-visits`]}
                    onChange={(event) => change(index, { visits: event.target.value })}
                  />
                ) : null}
              </div>
              <LocalizedFields
                id={`${id}-message`}
                legend={t('chatSettings.proactive.message')}
                hint={t('chatSettings.proactive.messageHint')}
                value={trigger.message}
                maxLength={160}
                error={errors[`trigger-${index}-message`]}
                onChange={(message) => change(index, { message })}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => setTriggers((all) => all.filter((_, i) => i !== index))}
              >
                <Trash2Icon aria-hidden="true" />
                {t('chatSettings.proactive.remove', { number })}
              </Button>
            </FieldSet>
          );
        })}
        {triggers.length < 5 ? (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() =>
              setTriggers((all) => [
                ...all,
                {
                  id: '',
                  kind: 'page_path',
                  path: '',
                  seconds: '5',
                  visits: '',
                  message: texts(),
                },
              ])
            }
          >
            <PlusIcon aria-hidden="true" />
            {t('chatSettings.proactive.add')}
          </Button>
        ) : null}
      </FieldSet>
      <ActionError error={save.error} />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={save.isPending}>
          {t('chatSettings.proactive.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ProactiveDialog({
  brand,
  open,
  onOpenChange,
}: {
  brand: Brand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const query = useStudioQuery<C.ProactiveSettingsView>(
    ['proactive', brand.id],
    proactivePath(brand),
    { enabled: open },
  );
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('chatSettings.proactive.title', { name: brand.name })}
      description={t('chatSettings.proactive.description')}
      className="sm:max-w-2xl"
      testId="proactive-dialog"
    >
      <QueryState query={query} label={t('chatSettings.proactive.loading')}>
        {(data) => (
          <ProactiveForm
            key={data.updatedAt ?? 'new'}
            brand={brand}
            initial={data.settings}
            onDone={() => onOpenChange(false)}
          />
        )}
      </QueryState>
    </AppDialog>
  );
}
