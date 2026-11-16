import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { cn } from '@hamnivo/ui/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { ActionError } from '../../components/States';
import { LANGUAGE_NAMES, LOCALES } from '../../i18n';
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
  setupKeys,
  usePublishAppearance,
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
import { LiveWidgetPreview } from './LiveWidgetPreview';
import { firstPreviewLanguage } from './PreviewColumn';
import { previewAway, previewText, WidgetPreview } from './WidgetPreview';

const SELECTABLE_LANGUAGES: readonly ChatLanguage[] = LOCALES;

/** A native colour picker only takes `#rrggbb`; anything else shows black until a colour is typed. */
const pickerValue = (colour: string) =>
  /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : '#000000';

/**
 * How a brand's chat looks and what it says (W03, board 04): the main colour, logo, corners,
 * greeting, offline text, rating and privacy link, with a live picture of the chat beside the
 * fields. A saved draft reaches customers only after publishing.
 *
 * It sits on the Look tab of the Chat widget page (`layout="page"`: Save stays put after saving,
 * and the page asks before leaving with changes), and in a dialog (`layout="dialog"`, with Cancel,
 * closing once saved).
 */
export function AppearanceForm({
  brand,
  view,
  layout = 'dialog',
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  brand: Pick<Brand, 'id' | 'name'> & { widgetId?: string };
  view: WidgetAppearanceView;
  layout?: 'dialog' | 'page';
  onDirtyChange?: (dirty: boolean) => void;
  /** Leaving without saving: the caller asks first when there are changes. Shows Cancel. */
  onCancel?: () => void;
  onSaved?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const widgetId = brand.widgetId;
  const [live, setLive] = useState(false);
  const announce = useAnnouncer();
  const save = useSaveAppearance(brand.id);
  const saved = draftOf(view.draftAppearance ?? view.appearance);
  const publish = usePublishAppearance(brand.id);
  const [draft, setDraft] = useState<AppearanceDraft>(saved);
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<ChatLanguage>(() => firstPreviewLanguage(i18n.language));
  const [away, setAway] = useState(false);
  const page = layout === 'page';
  const editable = can('widget.configure');
  const dirty = isDirty(draft, saved);

  const set = (patch: Partial<AppearanceDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setServer({});
    onDirtyChange?.(isDirty(next, saved));
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
    launcher: englishError(problems.launcher) ?? server.launcherLabel,
  };
  const fieldIds: Record<string, string> = {
    colour: 'look-colour',
    logo: 'look-logo',
    privacy: 'look-privacy',
    greeting: 'look-greeting-en',
    offline: 'look-offline-en',
    launcher: 'look-launcher-en',
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
      const result = await save.mutateAsync({
        appearance: bodyOf(draft),
        expectedRevision: view.draftRevision ?? 0,
      });
      // What was saved is the new starting point at once, without waiting for a reload.
      client.setQueryData([tenantId, ...setupKeys.appearance(brand.id)], result);
      announce(t('agentic.appearanceDraftSaved'));
      onDirtyChange?.(false);
      onSaved?.();
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          const key = field.path.replace(/^appearance\./, '').split('.')[0] ?? field.path;
          fields[key] = field.message;
        }
        setServer(fields);
      }
    }
  };

  const reset = () => {
    setDraft(saved);
    setServer({});
    setAttempted(false);
    onDirtyChange?.(false);
  };

  const colour = drawnColour(draft, DEFAULT_PRIMARY_COLOR);
  const on = onColour(colour);
  const logo = draft.logoUrl.trim() && !problems.logoUrl ? draft.logoUrl.trim() : null;

  const fields = (
    <>
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
      <SelectField
        id="look-font"
        label={t('agentic.font')}
        value={draft.fontFamily}
        onChange={(event) =>
          set({ fontFamily: event.target.value as AppearanceDraft['fontFamily'] })
        }
        options={[
          { value: 'system', label: 'System' },
          { value: 'dm-sans', label: 'DM Sans' },
          { value: 'noto-sans', label: 'Noto Sans' },
        ]}
      />
      <SelectField
        id="look-theme"
        label={t('agentic.theme')}
        hint={t('agentic.themeHint')}
        value={draft.theme}
        onChange={(event) => set({ theme: event.target.value as AppearanceDraft['theme'] })}
        options={[
          { value: 'auto', label: t('agentic.themeAuto') },
          { value: 'light', label: t('agentic.themeLight') },
          { value: 'dark', label: t('agentic.themeDark') },
        ]}
      />
      <SelectField
        id="look-header"
        label={t('agentic.headerStyle')}
        value={draft.headerStyle}
        onChange={(event) =>
          set({ headerStyle: event.target.value as AppearanceDraft['headerStyle'] })
        }
        options={[
          { value: 'brand', label: t('agentic.headerBrand') },
          { value: 'plain', label: t('agentic.headerPlain') },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          id="look-launcher-icon"
          label={t('agentic.launcherIcon')}
          value={draft.launcherIcon}
          onChange={(event) =>
            set({ launcherIcon: event.target.value as AppearanceDraft['launcherIcon'] })
          }
          options={[
            { value: 'chat', label: t('agentic.iconChat') },
            { value: 'message', label: t('agentic.iconMessage') },
            { value: 'help', label: t('agentic.iconHelp') },
            { value: 'sparkle', label: t('agentic.iconSparkle') },
          ]}
        />
        <SelectField
          id="look-launcher-size"
          label={t('agentic.launcherSize')}
          value={draft.launcherSize}
          onChange={(event) =>
            set({ launcherSize: event.target.value as AppearanceDraft['launcherSize'] })
          }
          options={[
            { value: 'small', label: t('agentic.sizeSmall') },
            { value: 'medium', label: t('agentic.sizeMedium') },
            { value: 'large', label: t('agentic.sizeLarge') },
          ]}
        />
      </div>
      <LocalizedFields
        id="look-launcher"
        legend={t('agentic.launcher')}
        value={draft.launcher}
        maxLength={80}
        error={errors.launcher}
        onChange={(launcher) => set({ launcher })}
      />
      <CheckboxField
        id="look-branding"
        label={t('agentic.showBranding')}
        checked={draft.showBranding}
        onCheckedChange={(showBranding) => set({ showBranding })}
      />
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
      <ActionError error={isCancelled(save.error) ? null : (save.error ?? publish.error)} />
      {isCancelled(save.error) ? (
        <p role="status" className="text-sm text-text-secondary">
          {t('app.cancelled')}
        </p>
      ) : null}
      {page ? (
        <div className="flex flex-wrap items-center gap-3">
          <ReasonedAction reason={editable ? null : t('chatWidget.noPermission')}>
            <Button type="submit" busy={save.isPending} disabled={!dirty}>
              {t('agentic.save')}
            </Button>
          </ReasonedAction>
          <ReasonedAction reason={dirty ? t('agentic.unsaved') : null}>
            <Button
              type="button"
              variant="secondary"
              busy={publish.isPending}
              disabled={dirty || !view.draftAppearance || !editable}
              onClick={() =>
                publish.mutate(view.draftRevision ?? 0, {
                  onSuccess: (result) => {
                    client.setQueryData([tenantId, ...setupKeys.appearance(brand.id)], result);
                    announce(t('agentic.appearancePublished'));
                  },
                })
              }
            >
              {t('agentic.publish')}
            </Button>
          </ReasonedAction>
          <Button type="button" variant="ghost" disabled={!dirty || save.isPending} onClick={reset}>
            {t('setup.appearance.reset')}
          </Button>
          {dirty ? (
            <span className="text-sm text-text-secondary" data-testid="look-unsaved">
              {t('chatWidget.unsaved')}
            </span>
          ) : null}
        </div>
      ) : (
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={!isDirty(draft, saved) || save.isPending}
            onClick={reset}
          >
            {t('setup.appearance.reset')}
          </Button>
          {onCancel ? (
            <Button type="button" variant="secondary" onClick={onCancel} disabled={save.isPending}>
              {t('app.cancel')}
            </Button>
          ) : null}
          <Button type="submit" busy={save.isPending}>
            {t('agentic.save')}
          </Button>
        </DialogFooter>
      )}
    </>
  );

  return (
    <form
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
      onSubmit={submit}
      noValidate
      data-testid="appearance-form"
    >
      {page ? (
        <section
          aria-labelledby="look-title"
          className="flex min-w-0 flex-col gap-6 rounded-xl border border-border bg-surface p-4 shadow-sm sm:p-6"
        >
          <div className="flex flex-col gap-1">
            <h2 id="look-title" tabIndex={-1} className="text-lg font-semibold text-text">
              {t('setup.appearance.title', { name: brand.name })}
            </h2>
            <p className="text-sm text-text-secondary">{t('setup.appearance.description')}</p>
          </div>
          {fields}
        </section>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">{fields}</div>
      )}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-3 lg:sticky lg:self-start',
          page ? 'lg:top-20' : 'lg:top-0',
        )}
      >
        <h3 className="text-sm font-semibold text-text">{t('setup.appearance.previewTitle')}</h3>
        <p className="text-sm text-text-secondary">
          {t(live ? 'agentic.livePreviewNote' : 'setup.appearance.previewNote')}
        </p>
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
          {live ? null : (
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
          )}
        </div>
        {widgetId ? (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setLive((value) => !value)}
              aria-expanded={live}
            >
              {t(live ? 'agentic.closeLivePreview' : 'agentic.livePreview')}
            </Button>
            {live ? (
              <LiveWidgetPreview
                widgetId={widgetId}
                name={brand.name}
                appearance={bodyOf(draft)}
                locale={lang}
              />
            ) : null}
          </>
        ) : null}
        {live ? null : (
          <WidgetPreview
            look={{
              fontFamily: draft.fontFamily,
              showBranding: draft.showBranding,
              theme: draft.theme,
              headerStyle: draft.headerStyle,
              launcherIcon: draft.launcherIcon,
              launcherSize: draft.launcherSize,
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
        )}
      </div>
    </form>
  );
}
