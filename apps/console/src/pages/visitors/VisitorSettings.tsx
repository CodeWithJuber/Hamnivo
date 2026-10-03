import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckboxField, SelectField } from '../../components/Fields';
import { Section } from '../../components/PageHeader';
import { ActionError } from '../../components/States';
import { useBrandRefs } from '../../lib/names';
import { useTenant } from '../../lib/tenant';
import {
  DEFAULT_VISITOR_SETTINGS,
  useSaveVisitorSettings,
  useVisitorSettings,
  type VisitorSettings,
} from '../../lib/visitors';

/**
 * Whether a brand notes which pages visitors view, and whether it keeps the part of a page address
 * after the question mark. For people who may configure the chat widget; the change applies from
 * each visitor's next page view.
 */
export function VisitorSettingsPanel() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const announce = useAnnouncer();
  const brands = useBrandRefs();
  const [chosen, setChosen] = useState('');
  const brandId = chosen || brands.items?.[0]?.id || '';
  const allowed = can('widget.configure') && brandId !== '';
  const saved = useVisitorSettings(brandId, allowed);
  const save = useSaveVisitorSettings(brandId);
  // What the person changed, until it is saved; before that the saved settings are what shows.
  const [edited, setEdited] = useState<VisitorSettings | null>(null);
  const shown = saved.data?.settings;
  const draft = edited ?? shown ?? DEFAULT_VISITOR_SETTINGS;
  if (!can('widget.configure') || (brands.items ?? []).length === 0) return null;

  const dirty =
    edited !== null &&
    shown !== undefined &&
    (edited.tracking !== shown.tracking || edited.keepQueryStrings !== shown.keepQueryStrings);
  return (
    <Section
      id="visitor-settings"
      title={t('inboxAlerts.live.settings.title')}
      description={t('inboxAlerts.live.settings.description')}
    >
      <form
        className="flex max-w-xl flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(draft, {
            onSuccess: () => {
              setEdited(null);
              announce(t('inboxAlerts.live.settings.saved'));
            },
          });
        }}
      >
        {(brands.items ?? []).length > 1 ? (
          <SelectField
            id="visitor-settings-brand"
            label={t('inboxAlerts.live.settings.brand')}
            value={brandId}
            onChange={(event) => {
              setChosen(event.target.value);
              setEdited(null);
            }}
            options={(brands.items ?? []).map((brand) => ({ value: brand.id, label: brand.name }))}
          />
        ) : null}
        <CheckboxField
          id="visitor-tracking"
          label={t('inboxAlerts.live.settings.tracking')}
          hint={t('inboxAlerts.live.settings.trackingHint')}
          checked={draft.tracking}
          onCheckedChange={(tracking) => setEdited({ ...draft, tracking })}
        />
        <CheckboxField
          id="visitor-queries"
          label={t('inboxAlerts.live.settings.queries')}
          hint={t('inboxAlerts.live.settings.queriesHint')}
          checked={draft.keepQueryStrings}
          disabled={!draft.tracking}
          onCheckedChange={(keepQueryStrings) => setEdited({ ...draft, keepQueryStrings })}
        />
        <p className="text-sm text-text-secondary">{t('inboxAlerts.live.settings.retention')}</p>
        <ActionError error={save.error ?? saved.error} />
        {save.isSuccess && !dirty ? (
          <p role="status" className="text-sm text-text-secondary">
            {t('inboxAlerts.live.settings.saved')}
          </p>
        ) : null}
        <Button type="submit" className="self-start" busy={save.isPending} disabled={!dirty}>
          {t('inboxAlerts.live.settings.save')}
        </Button>
      </form>
    </Section>
  );
}
