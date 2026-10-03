import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { playSound, unlockAudioOnFirstTouch } from '../../lib/alert-sounds';
import { inboxKeys } from '../../lib/inbox';
import {
  type Attention,
  chooseDesktopAlerts,
  chooseSound,
  desktopPermission,
  type InboxPreferences,
  isActive,
  pingAvailability,
  showDesktopAlert,
  useAlertSettings,
  useUnreadChats,
} from '../../lib/inbox-alerts';
import { type InboxAlert, useInboxAlertListener, useInboxStream } from '../../lib/inbox-live';
import { useTabBadge } from '../../lib/tab-badge-page';
import { useTenant } from '../../lib/tenant';

/** Alerts that arrive within this long of each other are heard as one. */
const BATCH_MS = 300;
/** Studio tells the gateway it is open this often. */
const PING_MS = 30_000;

const inWindow = () => document.visibilityState === 'visible' && document.hasFocus();

/**
 * Everything that makes the inbox heard and seen from any Studio page: the live connection, the
 * sound and desktop alert for each new chat or message, the count on the browser tab, and Studio's
 * "I am here" sign that decides when a person shows as online. It draws nothing itself.
 */
export function InboxAlerts() {
  const { t } = useTranslation();
  const { tenantId, can } = useTenant();
  const client = useQueryClient();
  const navigate = useNavigate();
  const announce = useAnnouncer();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const settings = useAlertSettings();
  const unread = useUnreadChats();
  const permitted = can('conversations.read');

  useInboxStream(permitted);
  useTabBadge(permitted ? unread : 0);

  // The listener below lives as long as the page; it reads what is current from here.
  const latest = useRef({ settings, pathname, t, announce, navigate });
  latest.current = { settings, pathname, t, announce, navigate };
  const pending = useRef<InboxAlert[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = () => {
    timer.current = undefined;
    const batch = pending.current;
    pending.current = [];
    if (batch.length === 0) return;
    const { settings, pathname, t, announce, navigate } = latest.current;
    const away = !inWindow();
    const attention: Attention = {
      away,
      // Reading a chat means being on its page with the window in front.
      reading: (id) => !away && decodeURIComponent(pathname).endsWith(`/inbox/${id}`),
    };
    const sound = chooseSound(batch, settings.sounds, attention);
    if (sound) void playSound(sound.sound, sound.volume);
    const words = (item: { kind: InboxAlert['kind']; name: string; preview: string | null }) => ({
      title: t(`inboxAlerts.alert.${item.kind}`, { name: item.name }),
      body: item.preview
        ? item.kind === 'assigned'
          ? t('inboxAlerts.alert.assignedBody', { name: item.name, preview: item.preview })
          : item.preview
        : t('inboxAlerts.alert.open'),
    });
    for (const item of chooseDesktopAlerts(
      batch,
      settings.desktop,
      desktopPermission(),
      attention,
    )) {
      showDesktopAlert(
        { ...words(item), tag: item.conversationId },
        () =>
          void navigate({
            to: '/inbox/$conversationId',
            params: { conversationId: item.conversationId },
            search: {},
          }),
      );
    }
    // Screen reader users hear a new chat on any page, unless they are already in it.
    const heard = batch.find((alert) => !attention.reading(alert.conversationId));
    if (heard) {
      announce(
        words({ kind: heard.kind, name: heard.customerName, preview: null }).title,
        'polite',
      );
    }
  };

  useInboxAlertListener((alert) => {
    pending.current.push(alert);
    timer.current ??= setTimeout(flush, BATCH_MS);
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Browsers keep a page silent until it has been touched; wake the sound system on the first touch.
  useEffect(() => unlockAudioOnFirstTouch(), []);

  // "I am here": a sign every 30 seconds, and one when the person comes back to the tab. It says
  // whether Studio was used in the last five minutes, which is what makes someone online or away.
  const lastUsed = useRef(Date.now());
  useEffect(() => {
    if (!permitted) return;
    const touch = () => {
      lastUsed.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    let moved = 0;
    const move = () => {
      // Moving the mouse counts, but is only noted once a second.
      if (Date.now() - moved > 1000) {
        moved = Date.now();
        touch();
      }
    };
    window.addEventListener('pointermove', move, { passive: true });
    const ping = () => {
      pingAvailability(tenantId, isActive(lastUsed.current, Date.now()))
        .then((availability) =>
          client.setQueryData<InboxPreferences>([tenantId, ...inboxKeys.preferences], (current) =>
            current ? { ...current, availability } : current,
          ),
        )
        .catch(() => undefined);
    };
    ping();
    const interval = setInterval(ping, PING_MS);
    const visible = () => {
      if (document.visibilityState === 'visible') ping();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
      window.removeEventListener('pointermove', move);
      document.removeEventListener('visibilitychange', visible);
      clearInterval(interval);
    };
  }, [permitted, tenantId, client]);

  return null;
}
