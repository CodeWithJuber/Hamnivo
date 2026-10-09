import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { ReasonedAction } from '@hamnivo/ui/components/reasoned-action';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChoiceField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { Section } from '../../components/PageHeader';
import { ActionError, QueryState } from '../../components/States';
import { isApiError } from '../../lib/api';
import { DOCS } from '../../lib/docs';
import { formatNumber } from '../../lib/format';
import type { BrandRef } from '../../lib/names';
import { isCancelled } from '../../lib/reauth';
import { useAppearance, type WidgetAppearance } from '../../lib/setup';
import { type ChatLanguage, DEFAULT_FORM_TEXT } from '../../lib/setup-data';
import { useTenant } from '../../lib/tenant';
import {
  CONSENT_MAX,
  CONSENT_MODES,
  type ConsentDraft,
  type ConsentMode,
  type ConsentSettingsView,
  consentBodyOf,
  consentDraftOf,
  consentProblemsOf,
  consentWordsChanged,
  isConsentDirty,
  useConsentSettings,
  useSaveConsent,
  widgetFormKeys,
} from '../../lib/widget-forms';
import { LocalizedFields } from '../BrandChatSettings';
import { LeaveGuard } from '../settings/DiscardChangesDialog';
import { firstPreviewLanguage, PreviewColumn } from '../settings/PreviewColumn';
import { previewLookOf, WidgetPreview } from '../settings/WidgetPreview';

const MODE_ID = 'consent-mode';
const TEXT_ID = 'consent-text';

function ConsentEditor({
  brand,
  view,
  appearance,
  onDirtyChange,
}: {
  brand: BrandRef;
  view: ConsentSettingsView;
  appearance: WidgetAppearance | undefined;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const { can, tenantId } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const save = useSaveConsent(brand.id);
  const saved = useMemo(() => consentDraftOf(view.consent), [view]);
  const [draft, setDraft] = useState<ConsentDraft>(saved);
  const [attempted, setAttempted] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [lang, setLang] = useState<ChatLanguage>(() => firstPreviewLanguage(i18n.language));
  const editable = can('widget.configure');
  const dirty = isConsentDirty(draft, saved);
  const wordsChanged = consentWordsChanged(draft, saved);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = (patch: Partial<ConsentDraft>) => {
    setDraft({ ...draft, ...patch });
    setServer({});
  };

  const problems = consentProblemsOf(draft);
  const errors: Record<string, string> = attempted
    ? {
        ...server,
        ...(problems.includes('english')
          ? { [`${TEXT_ID}-en`]: t('chatWidget.privacy.english') }
          : {}),
      }
    : {};
  const summary = Object.entries(errors).map(([fieldId, message]) => ({ fieldId, message }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setServer({});
    if (problems.length > 0) return;
    try {
      const result = await save.mutateAsync(consentBodyOf(draft));
      // What was saved is the new starting point at once, without waiting for a reload.
      client.setQueryData([tenantId, ...widgetFormKeys.consent(brand.id)], result);
      announce(t('chatWidget.privacy.saved', { name: brand.name }));
    } catch (error) {
      if (isApiError(error, 'VALIDATION_FAILED')) {
        const fields: Record<string, string> = {};
        for (const field of error.fields) {
          const id = field.path.startsWith('text') ? `${TEXT_ID}-en` : `${MODE_ID}-${draft.mode}`;
          fields[id] = fields[id] ? `${fields[id]} ${field.message}` : field.message;
        }
        setServer(fields);
      }
    }
  };

  // Hamnivo's own words show greyed while nothing is written; once English is, it is the
  // fallback for the other languages, so their boxes are left empty.
  const ownWords = (l: ChatLanguage) => DEFAULT_FORM_TEXT.consent[l].replace('{brand}', brand.name);
  const placeholders = draft.text.en.trim()
    ? {}
    : { en: ownWords('en'), ar: ownWords('ar'), hi: ownWords('hi'), ur: ownWords('ur') };
  const words = draft.text[lang].trim() || draft.text.en.trim() || ownWords(lang);
  const privacyUrl = appearance?.privacyUrl ?? null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <form
        className="flex min-w-0 flex-col gap-6"
        onSubmit={submit}
        noValidate
        data-testid="consent-form"
      >
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        <Section
          id="consent"
          title={t('chatWidget.privacy.title')}
          description={t('chatWidget.privacy.description')}
          actions={<GuideLink href={DOCS.setup.consent}>{t('chatWidget.privacy.guide')}</GuideLink>}
        >
          <ChoiceField
            id={MODE_ID}
            legend={t('chatWidget.privacy.mode')}
            value={draft.mode}
            error={errors[`${MODE_ID}-${draft.mode}`]}
            onValueChange={(mode) => set({ mode: mode as ConsentMode })}
            choices={CONSENT_MODES.map((mode) => ({
              value: mode,
              label: t(`chatWidget.privacy.modes.${mode}`),
              hint: t(`chatWidget.privacy.modes.${mode}Hint`),
            }))}
          />
          <LocalizedFields
            id={TEXT_ID}
            legend={t('chatWidget.privacy.text')}
            hint={t('chatWidget.privacy.textHint')}
            value={draft.text}
            maxLength={CONSENT_MAX}
            multiline
            placeholders={placeholders}
            error={errors[`${TEXT_ID}-en`]}
            onChange={(text) => set({ text })}
          />
          {wordsChanged ? (
            <p
              className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-text"
              data-testid="consent-reconsent"
            >
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>{t('chatWidget.privacy.reconsentNow')}</span>
            </p>
          ) : (
            <p className="text-sm text-text-secondary">{t('chatWidget.privacy.reconsent')}</p>
          )}
          <p className="text-sm text-text-secondary" data-testid="consent-version">
            {view.noticeVersion > 0
              ? t('chatWidget.privacy.version', { version: formatNumber(view.noticeVersion) })
              : t('chatWidget.privacy.versionNone')}
          </p>
          <div className="flex flex-col gap-1" data-testid="consent-privacy-link">
            <h3 className="text-sm font-medium text-text">{t('chatWidget.privacy.privacyLink')}</h3>
            {privacyUrl ? (
              <p className="text-sm break-all text-text">
                <bdi dir="ltr">{privacyUrl}</bdi>
              </p>
            ) : (
              <p className="text-sm text-text-secondary">{t('chatWidget.privacy.privacyNone')}</p>
            )}
            <p className="text-sm text-text-secondary">
              {t('chatWidget.privacy.privacyLinkHint')}{' '}
              <Link
                to="/chat-widget"
                search={{ brand: brand.id, tab: 'look' }}
                className="text-link underline underline-offset-4 hover:no-underline"
                data-testid="consent-open-look"
              >
                {t('chatWidget.privacy.privacyEdit')}
              </Link>
            </p>
          </div>
        </Section>
        <ActionError error={isCancelled(save.error) ? null : save.error} />
        {isCancelled(save.error) ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('app.cancelled')}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <ReasonedAction reason={editable ? null : t('chatWidget.noPermission')}>
            <Button type="submit" busy={save.isPending} disabled={!dirty}>
              {t('chatWidget.privacy.save')}
            </Button>
          </ReasonedAction>
          <Button
            type="button"
            variant="ghost"
            disabled={!dirty || save.isPending}
            onClick={() => {
              setDraft(saved);
              setServer({});
              setAttempted(false);
            }}
          >
            {t('chatWidget.reset')}
          </Button>
          {dirty ? (
            <span className="text-sm text-text-secondary" data-testid="consent-unsaved">
              {t('chatWidget.unsaved')}
            </span>
          ) : null}
        </div>
      </form>
      <PreviewColumn
        id="consent-preview"
        lang={lang}
        onLangChange={setLang}
        notice={draft.mode === 'off' ? t('chatWidget.preview.consentOff') : null}
      >
        <WidgetPreview
          look={previewLookOf(appearance, brand.name, lang)}
          screen="consent"
          content={{ consent: words }}
        />
      </PreviewColumn>
    </div>
  );
}

/** Consent before chatting (W27): who is asked, and the words they agree to. */
export function PrivacyTab({ brand }: { brand: BrandRef }) {
  const { t } = useTranslation();
  const consent = useConsentSettings(brand.id);
  const appearance = useAppearance(brand.id);
  const [dirty, setDirty] = useState(false);
  return (
    <div className="flex flex-col gap-4" data-testid="privacy-tab">
      <LeaveGuard dirty={dirty} />
      <QueryState query={consent} label={t('chatWidget.loading')}>
        {(view) => (
          <ConsentEditor
            key={`${brand.id}-${view.configVersion}-${view.noticeVersion}`}
            brand={brand}
            view={view}
            appearance={appearance.data?.appearance}
            onDirtyChange={setDirty}
          />
        )}
      </QueryState>
    </div>
  );
}
