import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { NativeSelect, NativeSelectOption } from '@hamnivo/ui/components/native-select';
import { cn } from '@hamnivo/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { BellIcon, BellRingIcon, CircleIcon, MessageSquareTextIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AVAILABILITY_STATUSES,
  type AvailabilityStatus,
  useAlertSettings,
  useAvailability,
  useChooseAvailability,
  useDesktopPermission,
} from '../../lib/inbox-alerts';
import { useTenant } from '../../lib/tenant';
import { AlertSettingsDialog } from './AlertSettings';

/** Online, away or offline: a dot (filled, filled, hollow) and always the word. */
export function StaffStatus({
  status,
  className,
}: {
  status: AvailabilityStatus;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-text-secondary', className)}
      data-status={status}
    >
      <CircleIcon
        className={cn(
          'size-2.5 shrink-0',
          status === 'online' && 'fill-current text-success',
          status === 'away' && 'fill-current text-warning',
          status === 'offline' && 'text-text-muted',
        )}
        aria-hidden="true"
      />
      {t(`inboxAlerts.status.${status}`)}
    </span>
  );
}

/** Whether you take chats now. Customers hear "a person is online" only while someone is. */
function StatusControl() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const availability = useAvailability();
  const { choose, saving } = useChooseAvailability();
  const value = availability?.choice ?? 'online';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <label htmlFor="my-status" className="text-sm text-text-secondary">
          {t('inboxAlerts.status.label')}
        </label>
        <NativeSelect
          id="my-status"
          size="sm"
          value={value}
          disabled={saving}
          aria-describedby="my-status-hint"
          onChange={(event) => {
            const status = event.target.value as AvailabilityStatus;
            choose(status, () =>
              announce(
                t('inboxAlerts.status.changed', { status: t(`inboxAlerts.status.${status}`) }),
              ),
            );
          }}
          data-testid="my-status"
        >
          {AVAILABILITY_STATUSES.map((status) => (
            <NativeSelectOption key={status} value={status}>
              {t(`inboxAlerts.status.${status}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <p id="my-status-hint" className="text-xs text-text-secondary">
        {availability?.choice === 'online' && availability.effective === 'away'
          ? t('inboxAlerts.status.idle')
          : t('inboxAlerts.status.hint')}
      </p>
    </div>
  );
}

/** What staff set up for themselves in the inbox: their status and their alerts. */
export function InboxToolbar() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const settings = useAlertSettings();
  const { can } = useTenant();
  const silent = settings.sounds.muted;
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <StatusControl />
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" size="sm">
          <Link to="/visitors" data-testid="live-visitors-link">
            <UsersIcon aria-hidden="true" />
            {t('inboxAlerts.live.link')}
          </Link>
        </Button>
        {can('inbox.manage') ? (
          <Button asChild variant="secondary" size="sm">
            <Link to="/saved-replies" search={{}} data-testid="saved-replies-link">
              <MessageSquareTextIcon aria-hidden="true" />
              {t('inboxAlerts.library.link')}
            </Link>
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
          data-testid="alert-settings-button"
        >
          {silent ? <BellIcon aria-hidden="true" /> : <BellRingIcon aria-hidden="true" />}
          {t('inboxAlerts.settings.button')}
        </Button>
      </div>
      <AlertSettingsDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

const DISMISSED_KEY = 'hamnivo.studio.desktop-alerts-dismissed';

function dismissedBefore(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** The question itself: in words, with a button to press (the browser's prompt needs a click). */
export function DesktopPromptCard({
  onAllow,
  onLater,
}: {
  onAllow: () => void;
  onLater: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-labelledby="desktop-alerts-title"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-muted p-3"
      data-testid="desktop-alerts-prompt"
    >
      <h2 id="desktop-alerts-title" className="text-sm font-semibold text-text">
        {t('inboxAlerts.banner.title')}
      </h2>
      <p className="text-sm text-text-secondary">{t('inboxAlerts.banner.description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onAllow}>
          {t('inboxAlerts.banner.allow')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onLater}>
          {t('inboxAlerts.banner.later')}
        </Button>
      </div>
    </section>
  );
}

/**
 * Asks, once, whether to allow desktop alerts. "Not now" is remembered in this browser, and the
 * question goes away for good once the browser has an answer.
 */
export function DesktopAlertsPrompt() {
  const settings = useAlertSettings();
  const [permission, ask] = useDesktopPermission();
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (!settings.desktop.enabled || permission !== 'default' || dismissed) return null;
  const later = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // The question then comes back next time the page opens.
    }
  };
  return <DesktopPromptCard onAllow={() => void ask()} onLater={later} />;
}
