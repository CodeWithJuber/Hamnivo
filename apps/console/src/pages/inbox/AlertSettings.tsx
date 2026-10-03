import { Button } from '@hamnivo/ui/components/button';
import { Label } from '@hamnivo/ui/components/label';
import { PlayIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog } from '../../components/AppDialog';
import { CheckboxField, SelectField } from '../../components/Fields';
import { playSound, SOUND_NAMES, type SoundName } from '../../lib/alert-sounds';
import {
  type AlertSettings,
  showDesktopAlert,
  useAlertSettings,
  useChangeAlertSettings,
  useDesktopPermission,
} from '../../lib/inbox-alerts';

const EVENTS = [
  { key: 'newChat', id: 'sound-new-chat' },
  { key: 'customerMessage', id: 'sound-customer-message' },
  { key: 'assigned', id: 'sound-assigned' },
] as const;

/** The volume slider: moves at once on screen, saves when the person stops (or after a moment). */
function Volume({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = draft ?? value;
  const commit = (next: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setDraft(null);
    if (next !== value) onCommit(next);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="alert-volume">{t('inboxAlerts.settings.volume')}</Label>
      <div className="flex items-center gap-3">
        <input
          id="alert-volume"
          type="range"
          min={0}
          max={100}
          step={5}
          value={shown}
          disabled={disabled}
          aria-valuetext={t('inboxAlerts.settings.volumeValue', { value: shown })}
          className="h-2 min-w-0 flex-1 accent-brand disabled:opacity-50"
          onChange={(event) => {
            const next = Number(event.target.value);
            setDraft(next);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => commit(next), 600);
          }}
          onPointerUp={() => draft !== null && commit(draft)}
          onKeyUp={() => draft !== null && commit(draft)}
          onBlur={() => draft !== null && commit(draft)}
          data-testid="alert-volume"
        />
        <output htmlFor="alert-volume" className="w-12 text-end text-sm text-text-secondary">
          {shown}%
        </output>
      </div>
    </div>
  );
}

function SoundPicker({
  id,
  label,
  value,
  settings,
  onChange,
  onBlocked,
}: {
  id: string;
  label: string;
  value: AlertSettings['sounds']['newChat'];
  settings: AlertSettings['sounds'];
  onChange: (value: AlertSettings['sounds']['newChat']) => void;
  onBlocked: () => void;
}) {
  const { t } = useTranslation();
  const silent = settings.muted || settings.volume <= 0;
  const sound = (name: SoundName | 'none') => t(`inboxAlerts.settings.sounds.${name}`);
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <SelectField
          id={id}
          label={label}
          value={value}
          onChange={(event) => onChange(event.target.value as typeof value)}
          options={[
            ...SOUND_NAMES.map((name) => ({ value: name, label: sound(name) })),
            { value: 'none', label: sound('none') },
          ]}
        />
      </div>
      <Button
        variant="secondary"
        size="icon"
        disabled={value === 'none' || silent}
        aria-label={t('inboxAlerts.settings.play', { sound: sound(value) })}
        onClick={() => {
          if (value === 'none') return;
          void playSound(value, settings.volume).then((played) => !played && onBlocked());
        }}
      >
        <PlayIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function DesktopSection({
  settings,
  change,
}: {
  settings: AlertSettings['desktop'];
  change: (desktop: Partial<AlertSettings['desktop']>) => void;
}) {
  const { t } = useTranslation();
  const [permission, ask] = useDesktopPermission();
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-semibold text-text">
        {t('inboxAlerts.settings.desktop.title')}
      </legend>
      <CheckboxField
        id="desktop-enabled"
        label={t('inboxAlerts.settings.desktop.enabled')}
        hint={t('inboxAlerts.settings.desktop.enabledHint')}
        checked={settings.enabled}
        onCheckedChange={(enabled) => change({ enabled })}
      />
      <CheckboxField
        id="desktop-preview"
        label={t('inboxAlerts.settings.desktop.preview')}
        hint={t('inboxAlerts.settings.desktop.previewHint')}
        checked={settings.showPreview}
        disabled={!settings.enabled}
        onCheckedChange={(showPreview) => change({ showPreview })}
      />
      <div className="flex flex-col items-start gap-2" data-testid="desktop-permission">
        {permission === 'unsupported' ? (
          <p className="text-sm text-text-secondary">
            {t('inboxAlerts.settings.desktop.unsupported')}
          </p>
        ) : null}
        {permission === 'default' ? (
          <>
            <p className="text-sm text-text-secondary">
              {t('inboxAlerts.settings.desktop.prompt')}
            </p>
            <Button variant="secondary" size="sm" onClick={() => void ask()}>
              {t('inboxAlerts.settings.desktop.allow')}
            </Button>
          </>
        ) : null}
        {permission === 'granted' ? (
          <>
            <p className="text-sm text-text-secondary">
              {t('inboxAlerts.settings.desktop.granted')}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                showDesktopAlert(
                  {
                    title: t('inboxAlerts.settings.desktop.testTitle'),
                    body: t('inboxAlerts.settings.desktop.testBody'),
                    tag: 'hamnivo-test',
                  },
                  () => undefined,
                )
              }
            >
              {t('inboxAlerts.settings.desktop.test')}
            </Button>
          </>
        ) : null}
        {permission === 'denied' ? (
          <p className="text-sm text-text">{t('inboxAlerts.settings.desktop.denied')}</p>
        ) : null}
      </div>
    </fieldset>
  );
}

/** The settings themselves, without the dialog around them. */
export function AlertSettingsForm() {
  const { t } = useTranslation();
  const settings = useAlertSettings();
  const { change, failed } = useChangeAlertSettings();
  const [blocked, setBlocked] = useState(false);
  const silent = settings.sounds.muted || settings.sounds.volume <= 0;
  return (
    <div className="flex flex-col gap-5" data-testid="alert-settings">
      <CheckboxField
        id="sounds-muted"
        label={t('inboxAlerts.settings.mute')}
        hint={t('inboxAlerts.settings.muteHint')}
        checked={settings.sounds.muted}
        onCheckedChange={(muted) => change({ sounds: { muted } })}
      />
      <Volume
        value={settings.sounds.volume}
        disabled={settings.sounds.muted}
        onCommit={(volume) => change({ sounds: { volume } })}
      />
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-text">
          {t('inboxAlerts.settings.events.title')}
        </legend>
        {EVENTS.map(({ key, id }) => (
          <SoundPicker
            key={key}
            id={id}
            label={t(`inboxAlerts.settings.events.${key}`)}
            value={settings.sounds[key]}
            settings={settings.sounds}
            onChange={(value) =>
              change({ sounds: { [key]: value } as Partial<AlertSettings['sounds']> })
            }
            onBlocked={() => setBlocked(true)}
          />
        ))}
        {silent ? (
          <p className="text-sm text-text-secondary">{t('inboxAlerts.settings.silent')}</p>
        ) : null}
        {blocked ? (
          <p role="status" className="text-sm text-text">
            {t('inboxAlerts.settings.blocked')}
          </p>
        ) : null}
      </fieldset>
      <DesktopSection settings={settings.desktop} change={(desktop) => change({ desktop })} />
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t('inboxAlerts.settings.saveFailed')}
        </p>
      ) : null}
    </div>
  );
}

/** Sounds, volume, mute and desktop alerts: each person's own (opened from the inbox). */
export function AlertSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('inboxAlerts.settings.title')}
      description={t('inboxAlerts.settings.description')}
      testId="alert-settings-dialog"
    >
      <AlertSettingsForm />
    </AppDialog>
  );
}
