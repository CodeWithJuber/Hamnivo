import type * as C from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { FieldDescription, FieldLegend, FieldSet } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogFooter } from '../components/AppDialog';
import {
  CheckboxField,
  ChoiceField,
  SelectField,
  TextareaField,
  TextField,
} from '../components/Fields';
import { ActionError } from '../components/States';
import { api, isApiError } from '../lib/api';
import { useStudioMutation, useStudioQuery } from '../lib/queries';
import { isCancelled } from '../lib/reauth';
import { useTenant } from '../lib/tenant';
import type { Brand } from '../lib/types';
import { firstPreviewLanguage, PreviewColumn } from './settings/PreviewColumn';
import { previewLookOf, WidgetPreview } from './settings/WidgetPreview';

/**
 * A brand's chat settings (widget.configure: W02 layout, W09 files, W17 help, W23 deletion, W25
 * emails), shown on the Behaviour tab of the Chat widget page. The gateway checks every value
 * again; the limits here only say early what it would refuse. (Website prompts are automations
 * now: see the Automations page.)
 */

type Settings = C.WidgetSettings;
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

const settingsPath = (brand: Pick<Brand, 'id'>) => `/v1/admin/brands/${brand.id}/widget-settings`;

/** The query key and address of a brand's chat settings. */
export const widgetSettingsKey = (brandId: string) => ['widget-settings', brandId] as const;
export const useWidgetSettings = (brandId: string, enabled = true) =>
  useStudioQuery<C.WidgetSettingsView>(widgetSettingsKey(brandId), settingsPath({ id: brandId }), {
    enabled,
  });

/** One text per language, English first and required. */
export function LocalizedFields({
  id,
  legend,
  hint,
  value,
  maxLength,
  error,
  onChange,
  multiline = false,
  placeholders,
  others,
}: {
  id: string;
  legend: string;
  hint?: string;
  value: Texts;
  maxLength: number;
  error?: string | undefined;
  onChange: (value: Texts) => void;
  /** Several lines per language, for longer words such as a consent question. */
  multiline?: boolean;
  /** Greyed words shown in an empty box: what customers read when it stays empty. */
  placeholders?: Partial<Texts> | undefined;
  /**
   * Keeps the other languages behind a disclosure with this name (English stays in view), for
   * lists where every item has words of its own. Its name says how many are written.
   */
  others?: (written: number) => string;
}) {
  const { t } = useTranslation();
  const written = LANGS.filter((lang) => lang !== 'en' && value[lang].trim()).length;
  const [open, setOpen] = useState(false);
  const field = (lang: Lang) => {
    const common = {
      id: `${id}-${lang}`,
      label: t(`chatSettings.languages.${lang}`),
      lang,
      dir: 'auto',
      value: value[lang],
      maxLength,
      error: lang === 'en' ? error : undefined,
      ...(placeholders?.[lang] ? { placeholder: placeholders[lang] } : {}),
    };
    return multiline ? (
      <TextareaField
        key={lang}
        {...common}
        rows={3}
        onChange={(event) => onChange({ ...value, [lang]: event.target.value })}
      />
    ) : (
      <TextField
        key={lang}
        {...common}
        onChange={(event) => onChange({ ...value, [lang]: event.target.value })}
      />
    );
  };
  return (
    <FieldSet className="gap-3 rounded-lg border border-border p-3">
      <FieldLegend variant="label" className="mb-0">
        {legend}
      </FieldLegend>
      {hint ? <FieldDescription className="mt-0">{hint}</FieldDescription> : null}
      {others ? (
        <>
          {field('en')}
          <details
            open={open}
            onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
            className="rounded-md"
          >
            <summary className="cursor-pointer text-sm font-medium text-text">
              {others(written)}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {LANGS.filter((lang) => lang !== 'en').map(field)}
            </div>
          </details>
        </>
      ) : (
        LANGS.map(field)
      )}
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

/** Where the gateway's refusal of a settings field points (`attachments.maxMegabytes` …). */
export function settingsControlOfPath(path: string): string {
  const [area, key, index, lang] = path.split('.');
  if (area === 'layout') return key === 'position' ? 'chat-position' : 'chat-mode-bubble';
  if (area === 'attachments') {
    if (key === 'maxMegabytes') return 'chat-maxMegabytes';
    if (key === 'maxFiles') return 'chat-maxFiles';
    if (key === 'allowedTypes') return `chat-type-${TYPE_KEYS['image/png']}`;
    return 'chat-files';
  }
  if (area === 'help') {
    if (key === 'suggestions' && index !== undefined && /^\d+$/.test(index)) {
      return `chat-suggestion-${index}-${lang && (LANGS as string[]).includes(lang) ? lang : 'en'}`;
    }
    return 'chat-search';
  }
  if (area === 'deletion') return 'chat-deletion';
  if (area === 'notifications') return 'chat-emails';
  return 'chat-mode-bubble';
}

/**
 * How the chat behaves (W02 layout, W09 files, W17 help, W23 deletion, W25 emails). On the Chat
 * widget page (`layout="page"`) it shows a picture of the chat beside the fields and keeps Save in
 * place; in a dialog (`layout="dialog"`) it has Cancel and closes once saved.
 */
export function SettingsForm({
  brand,
  initial,
  layout = 'dialog',
  appearance,
  onDone,
  onDirtyChange,
}: {
  brand: Pick<Brand, 'id' | 'name'>;
  initial: Settings;
  layout?: 'dialog' | 'page';
  /** The brand's saved look, to draw the picture in its colours (page only). */
  appearance?: C.WidgetAppearance | undefined;
  /** Cancel, or done after saving (dialog only). */
  onDone?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const saved = settingsDraft(initial);
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [server, setServer] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [lang, setLang] = useState<Lang>(() => firstPreviewLanguage(i18n.language));
  const page = layout === 'page';
  const editable = can('widget.configure');
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const save = useStudioMutation(
    (body: Settings, tenant) =>
      api<C.WidgetSettingsView>(settingsPath(brand), { method: 'PUT', body, tenant }),
    [widgetSettingsKey(brand.id)],
  );
  const set = (patch: Partial<SettingsDraft>) =>
    setDraft((d) => {
      const next = { ...d, ...patch };
      onDirtyChange?.(JSON.stringify(next) !== JSON.stringify(saved));
      return next;
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setServer({});
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
      const result = await save.mutateAsync({
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
      // What was saved is the new starting point at once, without waiting for a reload.
      client.setQueryData([tenantId, ...widgetSettingsKey(brand.id)], result);
      announce(t('chatSettings.saved', { name: brand.name }));
      onDirtyChange?.(false);
      onDone?.();
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          const id = settingsControlOfPath(field.path);
          fields[id] ??= field.message;
        }
        setServer(fields);
      }
    }
  };

  const idOf = (field: string) =>
    field.startsWith('suggestion-')
      ? `chat-${field}-en`
      : field === 'types'
        ? `chat-type-${TYPE_KEYS['image/png']}`
        : `chat-${field}`;
  const summary = attempted
    ? [
        ...Object.entries(errors).map(([field, message]) => ({ fieldId: idOf(field), message })),
        ...Object.entries(server)
          .filter(([id]) => !Object.keys(errors).some((field) => idOf(field) === id))
          .map(([fieldId, message]) => ({ fieldId, message })),
      ]
    : [];
  /** A field's own error, from the check here or from the gateway. */
  const errorOf = (field: string) => errors[field] ?? server[idOf(field)];

  const fields = (
    <>
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      <ChoiceField
        id="chat-mode"
        legend={t('chatSettings.layout.legend')}
        hint={t('chatSettings.layout.note')}
        value={draft.mode}
        error={server['chat-mode-bubble']}
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
        error={server['chat-position']}
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
              {errorOf('types') ? (
                <p className="text-sm text-danger" role="alert">
                  {errorOf('types')}
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
                error={errorOf('maxMegabytes')}
                onChange={(event) => set({ maxMegabytes: event.target.value })}
              />
              <TextField
                id="chat-maxFiles"
                label={t('chatSettings.files.maxFiles')}
                hint={t('chatSettings.files.maxFilesHint')}
                inputMode="numeric"
                value={draft.maxFiles}
                error={errorOf('maxFiles')}
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
              error={errorOf(`suggestion-${index}`)}
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
        error={errorOf('deletion')}
        onChange={(event) => set({ deleteMinutes: event.target.value })}
      />
      <CheckboxField
        id="chat-emails"
        label={t('chatSettings.emails.label')}
        hint={t('chatSettings.emails.hint')}
        checked={draft.emails}
        onCheckedChange={(emails) => set({ emails })}
      />
      <ActionError error={isCancelled(save.error) ? null : save.error} />
      {isCancelled(save.error) ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      {page ? (
        <div className="flex flex-wrap items-center gap-3">
          <ReasonedAction reason={editable ? null : t('chatWidget.noPermission')}>
            <Button type="submit" busy={save.isPending} disabled={!dirty}>
              {t('chatSettings.save')}
            </Button>
          </ReasonedAction>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(saved);
              setErrors({});
              setServer({});
              setAttempted(false);
              onDirtyChange?.(false);
            }}
          >
            {t('chatWidget.reset')}
          </Button>
          {dirty ? (
            <span className="text-sm text-text-secondary" data-testid="behaviour-unsaved">
              {t('chatWidget.unsaved')}
            </span>
          ) : null}
        </div>
      ) : (
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onDone} disabled={save.isPending}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {t('chatSettings.save')}
          </Button>
        </DialogFooter>
      )}
    </>
  );

  if (!page) {
    return (
      <form
        className="flex flex-col gap-6"
        onSubmit={submit}
        noValidate
        data-testid="chat-settings-form"
      >
        {fields}
      </form>
    );
  }

  const suggestions = draft.suggestions
    .map((question) => question[lang].trim() || question.en.trim())
    .filter(Boolean);
  return (
    <form
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
      onSubmit={submit}
      noValidate
      data-testid="chat-settings-form"
    >
      <section
        aria-labelledby="behaviour-title"
        className="flex min-w-0 flex-col gap-6 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="behaviour-title" tabIndex={-1} className="text-lg font-semibold text-text">
            {t('chatWidget.behaviour.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('chatWidget.behaviour.description')}</p>
        </div>
        {fields}
      </section>
      <PreviewColumn
        id="behaviour-preview"
        lang={lang}
        onLangChange={setLang}
        note={t('chatWidget.preview.layout', {
          layout: t(`chatSettings.layout.${draft.mode}`),
          side:
            draft.position === 'bottom-left'
              ? t('chatSettings.layout.left')
              : t('chatSettings.layout.right'),
        })}
      >
        <WidgetPreview
          look={previewLookOf(appearance, brand.name, lang)}
          content={{ suggestions, attachments: draft.files }}
        />
      </PreviewColumn>
    </form>
  );
}
