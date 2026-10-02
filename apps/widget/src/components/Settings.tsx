import type { HamnivoClient } from '@hamnivo/client';
import type { NotificationPreferences } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type DisplayControls, TEXT_SIZES } from '../useDisplay.js';

/**
 * Emails about the visitor's conversations (W25): offered to signed-in customers with a verified
 * address where the brand sends them; otherwise the reason is said plainly.
 */
function Emails({ client, person }: { client: HamnivoClient; person: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again for each person
  useEffect(() => {
    let cancelled = false;
    setPrefs(null);
    client
      .notifications()
      .then((next) => {
        if (!cancelled) setPrefs(next);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, person]);

  /** Shows the choice at once and keeps it when the server agrees; puts it back otherwise. */
  const change = async (input: { transcript?: boolean; replyWaiting?: boolean }) => {
    const before = prefs;
    if (before) setPrefs({ ...before, ...input });
    setBusy(true);
    try {
      setPrefs(await client.setNotifications(input));
      announce(t('surface.settings.saved'));
    } catch {
      setPrefs(before);
      announce(t('surface.settings.failed'));
    } finally {
      setBusy(false);
    }
  };

  const reason =
    prefs?.reason === 'not_verified'
      ? t('surface.settings.notVerified')
      : prefs?.reason === 'no_verified_email'
        ? t('surface.settings.noEmail')
        : prefs?.reason === 'turned_off_by_brand'
          ? t('surface.settings.notOffered')
          : null;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="email-settings">
      <legend className="mb-1 text-sm font-medium text-text">{t('surface.settings.emails')}</legend>
      {failed ? <p className="text-sm text-text-muted">{t('surface.settings.failed')}</p> : null}
      {reason ? <p className="text-sm text-text-muted">{reason}</p> : null}
      {prefs?.available ? (
        <>
          {prefs.email ? (
            <p className="text-sm text-text-muted">
              {t('surface.settings.emailsTo', { email: prefs.email })}
            </p>
          ) : null}
          {(['transcript', 'replyWaiting'] as const).map((key) => (
            <label key={key} htmlFor={`${id}-${key}`} className="flex items-start gap-2 text-sm">
              <input
                id={`${id}-${key}`}
                type="checkbox"
                className="mt-0.5 size-5 shrink-0 accent-primary"
                checked={prefs[key]}
                disabled={busy}
                onChange={(e) => void change({ [key]: e.target.checked })}
              />
              <span>{t(`surface.settings.${key}`)}</span>
            </label>
          ))}
        </>
      ) : null}
    </fieldset>
  );
}

/** Text size, motion and emails, in one panel of the chat (W14, W25). */
export function Settings(props: {
  client: HamnivoClient;
  person: string;
  display: DisplayControls;
  emails: boolean;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { display } = props;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      data-testid="settings"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-base font-semibold text-text">
          {t('surface.settings.title')}
        </h2>
        <Button variant="link" className="h-auto" onClick={props.onBack}>
          {t('surface.settings.back')}
        </Button>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text">
          {t('surface.settings.textSize')}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {TEXT_SIZES.map((size) => (
            <label key={size} htmlFor={`${id}-${size}`} className="flex items-center gap-2 text-sm">
              <input
                id={`${id}-${size}`}
                type="radio"
                name={`${id}-size`}
                className="size-5 accent-primary"
                checked={display.prefs.textSize === size}
                onChange={() => display.setTextSize(size)}
              />
              {t(`surface.settings.sizes.${size}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-motion`} className="flex items-start gap-2 text-sm">
          <input
            id={`${id}-motion`}
            type="checkbox"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            checked={display.reduced}
            disabled={display.system}
            onChange={(e) => display.setReduceMotion(e.target.checked)}
          />
          <span>{t('surface.settings.motion')}</span>
        </label>
        {display.system ? (
          <p className="ps-7 text-xs text-text-muted">{t('surface.settings.motionSystem')}</p>
        ) : null}
      </div>
      {props.emails ? <Emails client={props.client} person={props.person} /> : null}
    </section>
  );
}
