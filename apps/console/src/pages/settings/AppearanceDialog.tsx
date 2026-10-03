import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { ActionError, QueryState } from '../../components/States';
import { LANGUAGE_NAMES, LOCALES, type Locale } from '../../i18n';
import { isApiError } from '../../lib/api';
import {
  type AppearanceDraft,
  type AppearanceProblem,
  bodyOf,
  draftOf,
  drawnColour,
  isDirty,
  problemsOf,
} from '../../lib/appearance';
import { isCancelled } from '../../lib/reauth';
import {
  checkColour,
  onColour,
  useAppearance,
  useSaveAppearance,
  type WidgetAppearanceView,
} from '../../lib/setup';
import {
  type ChatLanguage,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_WIDGET_TEXT,
} from '../../lib/setup-data';
import { useTenant } from '../../lib/tenant';
import type { Brand } from '../../lib/types';
import { LocalizedFields } from '../BrandChatSettings';
import { DiscardChangesDialog } from './DiscardChangesDialog';
import { previewAway, previewText, WidgetPreview } from './WidgetPreview';

const SELECTABLE_LANGUAGES: readonly ChatLanguage[] = LOCALES;

/** A native colour picker only takes `#rrggbb`; anything else shows black until a colour is typed. */
const pickerValue = (colour: string) =>
  /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : '#000000';

export function AppearanceForm({
  brand,
  view,
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  brand: Brand;
  view: WidgetAppearanceView;
  onDirtyChange: (dirty: boolean) => void;
  /** Leaving without saving: the caller asks first when there are changes. */
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t, i18n } = useTranslation();
  const announce = useAnnouncer();
  const save = useSaveAppearance(brand.id);
  const saved = draftOf(view.appearance);
  const [draft, setDraft] = useState<AppearanceDraft>(saved);
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<ChatLanguage>(
    (SELECTABLE_LANGUAGES as readonly string[]).includes(i18n.language)
      ? (i18n.language as Locale)
      : 'en',
  );
  const [away, setAway] = useState(false);

  const set = (patch: Partial<AppearanceDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setServer({});
    onDirtyChange(isDirty(next, saved));
  };

  const problems = problemsOf(draft);
  const check = checkColour(draft.colour);
  const colourError = (problem: AppearanceProblem | undefined) =>
    problem === 'colourFormat'
      ? t('setup.appearance.colour.format')
      : problem === 'colourText'
        ? t('setup.appearance.colour.text')
        : problem === 'colourFaint'
          ? t('setup.appearance.colour.faint')
          : undefined;
  const urlError = (problem: AppearanceProblem | undefined) =>
    problem === 'url' ? t('setup.appearance.urlProblem') : undefined;
  const englishError = (problem: AppearanceProblem | undefined) =>
    problem === 'english' ? t('setup.appearance.englishFirst') : undefined;

  const errors: Record<string, string | undefined> = {
    colour: colourError(problems.colour) ?? server.primaryColor,
    logo: urlError(problems.logoUrl) ?? server.logoUrl,
    privacy: urlError(problems.privacyUrl) ?? server.privacyUrl,
    greeting: englishError(problems.greeting) ?? server.greeting,
    offline: englishError(problems.offline) ?? server.offlineText,
  };
  const fieldIds: Record<string, string> = {
    colour: 'look-colour',
    logo: 'look-logo',
    privacy: 'look-privacy',
    greeting: 'look-greeting-en',
    offline: 'look-offline-en',
  };
  const summary = attempted
    ? Object.entries(errors).flatMap(([field, message]) =>
        message ? [{ fieldId: fieldIds[field] ?? 'look-colour', message }] : [],
      )
    : [];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (Object.values(errors).some(Boolean)) return;
    try {
      await save.mutateAsync(bodyOf(draft));
      announce(t('setup.appearance.saved', { name: brand.name }));
      onSaved();
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          const key = field.path.split('.')[0] ?? field.path;
          fields[key] = field.message;
        }
        setServer(fields);
      }
    }
  };

  const colour = drawnColour(draft, DEFAULT_PRIMARY_COLOR);
  const on = onColour(colour);
  const logo = draft.logoUrl.trim() && !problems.logoUrl ? draft.logoUrl.trim() : null;

  return (
    <form
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
      onSubmit={submit}
      noValidate
      data-testid="appearance-form"
    >
      <div className="flex min-w-0 flex-col gap-6">
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <TextField
              id="look-colour"
              label={t('setup.appearance.colour.label')}
              hint={t('setup.appearance.colour.hint')}
              value={draft.colour}
              dir="ltr"
              maxLength={7}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => set({ colour: event.target.value })}
              error={errors.colour}
            />
            <input
              type="color"
              aria-label={t('setup.appearance.colour.pick')}
              value={pickerValue(draft.colour)}
              onChange={(event) => set({ colour: event.target.value.toUpperCase() })}
              className="mb-1 h-10 w-14 cursor-pointer rounded-md border border-input bg-surface p-1"
            />
          </div>
          {check?.problem && check.suggestion ? (
            <div
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3 text-sm"
              data-testid="colour-suggestion"
            >
              <span
                aria-hidden="true"
                className="size-6 shrink-0 rounded-md border border-border"
                style={{ backgroundColor: check.suggestion }}
              />
              <span className="min-w-0 flex-1 text-text">
                {t('setup.appearance.colour.suggest', { colour: check.suggestion })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => set({ colour: check.suggestion ?? draft.colour })}
              >
                {t('setup.appearance.colour.apply', { colour: check.suggestion })}
              </Button>
            </div>
          ) : null}
        </div>
        <TextField
          id="look-logo"
          label={t('setup.appearance.logo.label')}
          hint={t('setup.appearance.logo.hint')}
          labelNote={t('app.optional')}
          type="url"
          value={draft.logoUrl}
          dir="ltr"
          spellCheck={false}
          maxLength={500}
          onChange={(event) => set({ logoUrl: event.target.value })}
          error={errors.logo}
        />
        <div className="flex flex-col gap-2">
          <label htmlFor="look-radius" className="text-sm font-medium text-text">
            {t('setup.appearance.radius.label')}{' '}
            <span className="font-normal text-text-secondary">
              ({t('setup.appearance.radius.value', { px: draft.radius })})
            </span>
          </label>
          <input
            id="look-radius"
            type="range"
            min={0}
            max={24}
            step={1}
            value={draft.radius}
            aria-describedby="look-radius-hint"
            onChange={(event) => set({ radius: Number(event.target.value) })}
            className="w-full"
          />
          <p id="look-radius-hint" className="text-sm text-text-secondary">
            {t('setup.appearance.radius.hint')}
          </p>
        </div>
        <LocalizedFields
          id="look-greeting"
          legend={t('setup.appearance.greeting.label')}
          hint={t('setup.appearance.greeting.hint')}
          value={draft.greeting}
          maxLength={300}
          error={errors.greeting}
          onChange={(greeting) => set({ greeting })}
        />
        <LocalizedFields
          id="look-offline"
          legend={t('setup.appearance.offline.label')}
          hint={t('setup.appearance.offline.hint')}
          value={draft.offline}
          maxLength={300}
          error={errors.offline}
          onChange={(offline) => set({ offline })}
        />
        <CheckboxField
          id="look-csat"
          label={t('setup.appearance.csat.label')}
          hint={t('setup.appearance.csat.hint')}
          checked={draft.csat}
          onCheckedChange={(csat) => set({ csat })}
        />
        <TextField
          id="look-privacy"
          label={t('setup.appearance.privacy.label')}
          hint={t('setup.appearance.privacy.hint')}
          labelNote={t('app.optional')}
          type="url"
          value={draft.privacyUrl}
          dir="ltr"
          spellCheck={false}
          maxLength={500}
          onChange={(event) => set({ privacyUrl: event.target.value })}
          error={errors.privacy}
        />
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        {isCancelled(save.error) ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={!isDirty(draft, saved) || save.isPending}
            onClick={() => {
              setDraft(saved);
              setServer({});
              setAttempted(false);
              onDirtyChange(false);
            }}
          >
            {t('setup.appearance.reset')}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" busy={save.isPending}>
            {t('setup.appearance.save')}
          </Button>
        </DialogFooter>
      </div>
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-0 lg:self-start">
        <h3 className="text-sm font-semibold text-text">{t('setup.appearance.previewTitle')}</h3>
        <p className="text-sm text-text-secondary">{t('setup.appearance.previewNote')}</p>
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            id="look-preview-lang"
            label={t('setup.appearance.previewLanguage')}
            value={lang}
            onChange={(event) => setLang(event.target.value as ChatLanguage)}
            options={SELECTABLE_LANGUAGES.map((code) => ({
              value: code,
              label: LANGUAGE_NAMES[code],
            }))}
          />
          <SelectField
            id="look-preview-state"
            label={t('setup.appearance.previewState')}
            value={away ? 'away' : 'online'}
            onChange={(event) => setAway(event.target.value === 'away')}
            options={[
              { value: 'online', label: t('setup.appearance.stateOnline') },
              { value: 'away', label: t('setup.appearance.stateAway') },
            ]}
          />
        </div>
        <WidgetPreview
          look={{
            name: brand.name,
            colour,
            on,
            radius: draft.radius,
            logoUrl: logo,
            greeting: previewText(
              draft.greeting,
              lang,
              // Hamnivo's own greeting is shown until the brand writes one.
              DEFAULT_WIDGET_TEXT.greeting[lang],
            ),
            away: previewAway(draft.offline, lang),
            showAway: away,
            csat: draft.csat,
            privacyUrl: draft.privacyUrl.trim() && !problems.privacyUrl ? draft.privacyUrl : null,
            lang,
          }}
        />
      </div>
    </form>
  );
}

/**
 * How a brand's chat looks and what it says (W03, board 04): the main colour, logo, corners,
 * greeting, offline text, rating and privacy link, with a live picture of the chat beside the
 * fields. Nothing reaches customers until it is saved, and leaving with changes asks first.
 */
export function AppearanceDialog({
  brand,
  open,
  onOpenChange,
}: {
  brand: Brand;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { can } = useTenant();
  const appearance = useAppearance(brand.id, open && can('widget.configure'));
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const close = () => {
    setDirty(false);
    setLeaving(false);
    onOpenChange(false);
  };
  const request = (next: boolean) => {
    if (next) return;
    if (dirty) setLeaving(true);
    else close();
  };

  return (
    <>
      <AppDialog
        open={open}
        onOpenChange={request}
        title={t('setup.appearance.title', { name: brand.name })}
        description={t('setup.appearance.description')}
        className="sm:max-w-5xl"
        testId="appearance-dialog"
      >
        <QueryState
          query={appearance}
          label={t('setup.appearance.loading')}
          permitted={can('widget.configure')}
        >
          {(view) => (
            <AppearanceForm
              key={`${brand.id}-${view.configVersion}`}
              brand={brand}
              view={view}
              onDirtyChange={setDirty}
              onCancel={() => request(false)}
              onSaved={close}
            />
          )}
        </QueryState>
      </AppDialog>
      <DiscardChangesDialog open={leaving} onKeep={() => setLeaving(false)} onDiscard={close} />
    </>
  );
}
