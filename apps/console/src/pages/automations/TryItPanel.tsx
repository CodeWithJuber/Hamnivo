import { DEVICES, evaluate, FIELDS_BY_KIND, OWNERS } from '@hamnivo/domain/automations';
import { CheckIcon, CircleHelpIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SelectField, TextField } from '../../components/Fields';
import { LANGUAGE_NAMES, RTL_LOCALES } from '../../i18n';
import {
  type AutomationDraft,
  type AutomationKind,
  type AutomationOptions,
  type ConditionField,
  choiceText,
  conditionText,
  definitionOf,
  domainOf,
  factsOf,
  previewLanguageOf,
  type SampleFacts,
  type Tri,
  wordsIn,
} from '../../lib/automations';

/** Languages a sample visitor can speak: the chat's, then a few common others. */
const SAMPLE_LANGUAGES = ['en', 'ar', 'hi', 'ur', 'fr', 'es', 'de', 'tr', 'id', 'bn', 'fa'];

/** Whether the screen is wide enough for the panel beside the form (Tailwind's `lg`). */
export function useWide(query = '(min-width: 64rem)') {
  const [wide, setWide] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const media = window.matchMedia(query);
    const change = () => setWide(media.matches);
    change();
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, [query]);
  return wide;
}

function Verdict({ result }: { result: boolean | null }) {
  const { t } = useTranslation();
  const label = t(`automations.editor.try.verdicts.${String(result) as 'true'}`);
  const Icon = result === true ? CheckIcon : result === false ? XIcon : CircleHelpIcon;
  const tone =
    result === true ? 'text-success' : result === false ? 'text-danger' : 'text-text-secondary';
  return (
    <span className={`flex shrink-0 items-center gap-1 text-sm font-medium ${tone}`}>
      <Icon className="size-4" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

/**
 * "Try it": a sample visitor or chat, and what the rule would do with it. The verdicts come from
 * the domain's `evaluate`, the check the gateway and the worker run; a fact left empty is unknown,
 * and a condition on an unknown fact never holds, as for the real rule.
 */
function TryItBody({
  kind,
  draft,
  options,
  sample,
  onSampleChange,
}: {
  kind: AutomationKind;
  draft: AutomationDraft;
  options: AutomationOptions | undefined;
  sample: SampleFacts;
  onSampleChange: (sample: SampleFacts) => void;
}) {
  const { t, i18n } = useTranslation();
  const definition = definitionOf(draft);
  const verdict = evaluate(domainOf(definition), factsOf(sample));
  const fields = FIELDS_BY_KIND[kind];
  const has = (field: ConditionField) => fields.includes(field);
  const set = (patch: Partial<SampleFacts>) => onSampleChange({ ...sample, ...patch });
  const unknown = t('automations.editor.try.unknown');
  const names = { team: (id: string) => options?.teams.find((team) => team.id === id)?.name };
  const tri = (field: 'signed_in' | 'hours_open' | 'anyone_online') => (
    <SelectField
      key={field}
      id={`try-${field}`}
      label={t(`automations.editor.fields.${field}`)}
      value={sample[field]}
      onChange={(event) => set({ [field]: event.target.value as Tri })}
      options={[
        { value: '', label: unknown },
        { value: 'yes', label: t('automations.editor.try.yes') },
        { value: 'no', label: t('automations.editor.try.no') },
      ]}
    />
  );
  const lang = previewLanguageOf(sample);
  const messages = draft.actions.filter(
    (action) => action.type === 'show_prompt' || action.type === 'send_message',
  );
  const languageName = (code: string) => {
    try {
      return new Intl.DisplayNames(i18n.language, { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">{t('automations.editor.try.description')}</p>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-semibold text-text">
          {t('automations.editor.try.sample')}
        </legend>
        {has('page_url') ? (
          <TextField
            id="try-page_url"
            label={t('automations.editor.fields.page_url')}
            dir="ltr"
            value={sample.page_url}
            onChange={(event) => set({ page_url: event.target.value })}
          />
        ) : null}
        {has('referrer') ? (
          <TextField
            id="try-referrer"
            label={t('automations.editor.fields.referrer')}
            dir="ltr"
            value={sample.referrer}
            onChange={(event) => set({ referrer: event.target.value })}
          />
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          {has('visit_count') ? (
            <TextField
              id="try-visit_count"
              label={t('automations.editor.fields.visit_count')}
              inputMode="numeric"
              value={sample.visit_count}
              onChange={(event) => set({ visit_count: event.target.value })}
            />
          ) : null}
          {has('country') ? (
            <TextField
              id="try-country"
              label={t('automations.editor.fields.country')}
              hint={t('automations.editor.try.countryHint')}
              dir="ltr"
              maxLength={2}
              value={sample.country}
              onChange={(event) => set({ country: event.target.value })}
            />
          ) : null}
          {has('device') ? (
            <SelectField
              id="try-device"
              label={t('automations.editor.fields.device')}
              value={sample.device}
              onChange={(event) => set({ device: event.target.value })}
              options={[
                { value: '', label: unknown },
                ...DEVICES.map((device) => ({
                  value: device,
                  label: choiceText('device', device, t),
                })),
              ]}
            />
          ) : null}
          {has('language') ? (
            <SelectField
              id="try-language"
              label={t('automations.editor.fields.language')}
              value={sample.language}
              onChange={(event) => set({ language: event.target.value })}
              options={[
                { value: '', label: unknown },
                ...SAMPLE_LANGUAGES.map((code) => ({ value: code, label: languageName(code) })),
              ]}
            />
          ) : null}
        </div>
        {(['signed_in', 'hours_open', 'anyone_online'] as const).filter(has).map(tri)}
        {has('owner') ? (
          <SelectField
            id="try-owner"
            label={t('automations.editor.fields.owner')}
            value={sample.owner}
            onChange={(event) => set({ owner: event.target.value })}
            options={[
              { value: '', label: unknown },
              ...OWNERS.map((owner) => ({ value: owner, label: choiceText('owner', owner, t) })),
            ]}
          />
        ) : null}
        {has('tag') ? (
          <TextField
            id="try-tag"
            label={t('automations.editor.fields.tag')}
            hint={t('automations.editor.try.tagsHint')}
            value={sample.tag}
            onChange={(event) => set({ tag: event.target.value })}
          />
        ) : null}
        {has('team') ? (
          <SelectField
            id="try-team"
            label={t('automations.editor.fields.team')}
            value={sample.team}
            onChange={(event) => set({ team: event.target.value })}
            options={[
              { value: '', label: unknown },
              ...(options?.teams ?? []).map((team) => ({ value: team.id, label: team.name })),
            ]}
          />
        ) : null}
      </fieldset>

      <div className="flex flex-col gap-2" data-testid="try-verdicts">
        {definition.conditions.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('automations.editor.try.noConditions')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {definition.conditions.map((condition, index) => (
              <li
                key={draft.conditions[index]?.key ?? index}
                className="flex items-start justify-between gap-3 rounded-md border border-border p-2 text-sm"
                data-testid="try-verdict"
                data-result={String(verdict.conditions[index] ?? null)}
              >
                <span className="min-w-0 text-text">
                  <bdi>{conditionText(condition, t, names)}</bdi>
                </span>
                <Verdict result={verdict.conditions[index] ?? null} />
              </li>
            ))}
          </ul>
        )}
        <p
          role="status"
          data-testid="try-result"
          data-matched={verdict.matched}
          className={`flex items-center gap-2 rounded-lg p-3 text-sm font-semibold ${
            verdict.matched
              ? 'border border-success/40 bg-success-subtle text-text'
              : 'border border-border bg-surface-sunken text-text'
          }`}
        >
          {verdict.matched ? (
            <CheckIcon className="size-4 text-success" aria-hidden="true" />
          ) : (
            <XIcon className="size-4 text-text-secondary" aria-hidden="true" />
          )}
          {verdict.matched
            ? t('automations.editor.try.would')
            : t('automations.editor.try.wouldNot')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text">{t('automations.editor.try.preview')}</h3>
        {messages.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('automations.editor.try.noWords')}</p>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              {t('automations.editor.try.previewIn', { language: LANGUAGE_NAMES[lang] })}
            </p>
            {messages.map((action) => {
              const words = wordsIn(action.message, lang);
              return (
                <div
                  key={action.key}
                  lang={words.lang}
                  dir={RTL_LOCALES.has(words.lang) ? 'rtl' : 'ltr'}
                  data-testid="try-bubble"
                  className="max-w-[85%] self-start rounded-2xl rounded-ss-sm border border-border bg-surface-sunken px-3 py-2 text-sm whitespace-pre-wrap text-text"
                >
                  {words.text || '…'}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The panel beside the editor on wide screens (it stays in view while the form scrolls), and a
 * section that opens and closes under the form on phones.
 */
export function TryItPanel(props: {
  kind: AutomationKind;
  draft: AutomationDraft;
  options: AutomationOptions | undefined;
  sample: SampleFacts;
  onSampleChange: (sample: SampleFacts) => void;
  wide: boolean;
}) {
  const { t } = useTranslation();
  const { wide, ...body } = props;
  if (wide) {
    return (
      <aside
        aria-labelledby="try-it-title"
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto"
        data-testid="try-it"
      >
        <h2 id="try-it-title" className="text-lg font-semibold text-text">
          {t('automations.editor.try.title')}
        </h2>
        <TryItBody {...body} />
      </aside>
    );
  }
  return (
    <details
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
      data-testid="try-it"
    >
      <summary className="cursor-pointer text-lg font-semibold text-text">
        {t('automations.editor.try.title')}
      </summary>
      <div className="mt-3">
        <TryItBody {...body} />
      </div>
    </details>
  );
}
