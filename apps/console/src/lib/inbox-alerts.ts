/**
 * What a staff member hears and sees when customers write: the sounds and desktop alerts they
 * chose, whether they are online, the count of chats that need them, and the rules that turn an
 * alert from the inbox stream into a sound and a desktop notification. The rules are plain
 * functions so they can be tested; the rest talks to the gateway or the browser.
 */
import type * as C from '@hamnivo/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { SoundName } from './alert-sounds';
import { api } from './api';
import { inboxKeys } from './inbox';
import type { InboxAlert } from './inbox-live';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type AlertSettings = C.InboxAlertSettings;
export type InboxPreferences = C.InboxPreferences;
export type StaffAvailability = C.StaffAvailability;
export type AvailabilityStatus = C.AvailabilityStatus;
export type SoundChoice = C.AlertSoundChoice;
export type AlertKind = C.InboxAlertKind;
export type SettingsChange = C.UpdateInboxAlertSettings;

export const AVAILABILITY_STATUSES: readonly AvailabilityStatus[] = ['online', 'away', 'offline'];

/** What a person has until they choose (the same as the gateway's). */
export const DEFAULT_SETTINGS: AlertSettings = {
  sounds: { muted: false, volume: 60, newChat: 'chime', customerMessage: 'pop', assigned: 'bell' },
  desktop: { enabled: true, showPreview: true },
};

// ------------------------------------------------------------------ rules

/** The setting that picks the sound for each kind of alert. */
export function soundFor(sounds: AlertSettings['sounds'], kind: AlertKind): SoundChoice {
  switch (kind) {
    // A chat past its reply-time target (H12) is as pressing as a new one waiting, for its lead too.
    case 'sla_overdue':
    case 'sla_overdue_lead':
    case 'chat_waiting':
      return sounds.newChat;
    // A chat offered to this person (HNV-10-03) is theirs to answer, like an assignment.
    case 'chat_offered':
    case 'assigned':
      return sounds.assigned;
    case 'customer_message':
      return sounds.customerMessage;
  }
}

/** When several alerts arrive together, one sound plays: the most important kind. */
const PRIORITY: readonly AlertKind[] = [
  'chat_offered',
  'sla_overdue',
  'sla_overdue_lead',
  'chat_waiting',
  'assigned',
  'customer_message',
];

/** Where the person is, which decides what is worth interrupting them with. */
export interface Attention {
  /** Whether the person is reading this conversation right now (page open, window in front). */
  reading: (conversationId: string) => boolean;
  /** The tab is hidden or another window is in front. */
  away: boolean;
}

/**
 * The sound for a batch of alerts, or null for silence: muted, volume at zero, "no sound" for the
 * event, or a message in the very chat the person is reading.
 */
export function chooseSound(
  alerts: readonly InboxAlert[],
  sounds: AlertSettings['sounds'],
  attention: Attention,
): { sound: SoundName; volume: number } | null {
  if (sounds.muted || sounds.volume <= 0) return null;
  const heard = alerts
    .filter(
      (alert) => !(alert.kind === 'customer_message' && attention.reading(alert.conversationId)),
    )
    .sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  for (const alert of heard) {
    const choice = soundFor(sounds, alert.kind);
    if (choice !== 'none') return { sound: choice, volume: sounds.volume };
  }
  return null;
}

/** A desktop alert to show: which chat it opens, and what it says. */
export interface DesktopAlert {
  conversationId: string;
  kind: AlertKind;
  name: string;
  /** The start of the customer's message, or null to show none. */
  preview: string | null;
}

/** At most this many desktop alerts for one batch; the person gets the rest in the inbox. */
const MAX_DESKTOP_ALERTS = 3;

/**
 * The desktop alerts for a batch: none unless the person turned them on, the browser allows them
 * and they are looking elsewhere. One per chat, the newest wording.
 */
export function chooseDesktopAlerts(
  alerts: readonly InboxAlert[],
  desktop: AlertSettings['desktop'],
  permission: DesktopPermission,
  attention: Attention,
): DesktopAlert[] {
  if (!desktop.enabled || permission !== 'granted' || !attention.away) return [];
  const byChat = new Map<string, DesktopAlert>();
  for (const alert of alerts) {
    const known = byChat.get(alert.conversationId);
    // A chat that has just started waiting or been assigned says more than a message in it.
    if (known && PRIORITY.indexOf(known.kind) < PRIORITY.indexOf(alert.kind)) continue;
    byChat.set(alert.conversationId, {
      conversationId: alert.conversationId,
      kind: alert.kind,
      name: alert.customerName,
      preview: desktop.showPreview ? alert.preview : null,
    });
  }
  return [...byChat.values()].slice(0, MAX_DESKTOP_ALERTS);
}

/** Applies a partial change to the settings, as the gateway does. */
export function mergeSettings(settings: AlertSettings, change: SettingsChange): AlertSettings {
  return {
    sounds: { ...settings.sounds, ...change.sounds },
    desktop: { ...settings.desktop, ...change.desktop },
  };
}

/** Studio counts a person as active when they used it in the last five minutes. */
export const ACTIVE_WINDOW_MS = 5 * 60_000;
export const isActive = (lastUsed: number, now: number) => now - lastUsed < ACTIVE_WINDOW_MS;

// ------------------------------------------------------------------ gateway calls

export function usePreferences() {
  const { can } = useTenant();
  return useStudioQuery<InboxPreferences>(inboxKeys.preferences, '/v1/inbox/preferences', {
    enabled: can('conversations.read'),
  });
}

/** The person's alert settings: what they chose, or the defaults while it loads. */
export function useAlertSettings(): AlertSettings {
  return usePreferences().data?.alerts ?? DEFAULT_SETTINGS;
}

/** Changes the settings at once on screen and saves them; a failure puts the saved ones back. */
export function useChangeAlertSettings() {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...inboxKeys.preferences];
  const save = useStudioMutation<SettingsChange, InboxPreferences>((change, tenant) =>
    api<InboxPreferences>('/v1/inbox/preferences', {
      method: 'PATCH',
      tenant,
      body: change,
    }),
  );
  return {
    saving: save.isPending,
    failed: save.isError,
    change(change: SettingsChange) {
      client.setQueryData<InboxPreferences>(key, (current) =>
        current ? { ...current, alerts: mergeSettings(current.alerts, change) } : current,
      );
      save.mutate(change, {
        onSuccess: (preferences) => client.setQueryData(key, preferences),
        onError: () => void client.invalidateQueries({ queryKey: key }),
      });
    },
  };
}

export function useAvailability() {
  const preferences = usePreferences();
  return preferences.data?.availability ?? null;
}

export function useChooseAvailability() {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...inboxKeys.preferences];
  const save = useStudioMutation<AvailabilityStatus, StaffAvailability>((status, tenant) =>
    api<StaffAvailability>('/v1/inbox/availability', {
      method: 'PUT',
      tenant,
      body: { status },
    }),
  );
  return {
    saving: save.isPending,
    choose(status: AvailabilityStatus, done?: () => void) {
      save.mutate(status, {
        onSuccess: (availability) => {
          client.setQueryData<InboxPreferences>(key, (current) =>
            current ? { ...current, availability } : current,
          );
          done?.();
        },
      });
    },
  };
}

/** Studio's sign of life; the answer is how the person shows to others. */
export const pingAvailability = (tenantId: string, active: boolean) =>
  api<StaffAvailability>('/v1/inbox/availability/ping', {
    method: 'POST',
    tenant: tenantId,
    body: { active },
  });

/** How many chats need this person (theirs, or waiting for a person, with messages unread). */
export function useUnreadChats(): number {
  const { can } = useTenant();
  const unread = useStudioQuery<C.UnreadSummary>(inboxKeys.unread, '/v1/inbox/unread', {
    enabled: can('conversations.reply'),
    // The stream says when it changes; this only catches what a dropped connection missed.
    refetchInterval: 60_000,
  });
  return unread.data?.chats ?? 0;
}

/** Marks the customer's messages in a chat as read by this person. */
export const markRead = (tenantId: string, conversationId: string) =>
  api<void>(`/v1/inbox/conversations/${encodeURIComponent(conversationId)}/read`, {
    method: 'POST',
    tenant: tenantId,
  });

/**
 * Marks the open conversation read once the person has had a moment to see it, while the window
 * is in front: at once for new messages, and when they come back to the window otherwise.
 */
export function useMarkReadWhileOpen(conversationId: string, unreadCount: number): void {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  useEffect(() => {
    if (unreadCount <= 0) return;
    let done = false;
    const looking = () => document.visibilityState === 'visible' && document.hasFocus();
    const mark = () => {
      if (done || !looking()) return;
      done = true;
      markRead(tenantId, conversationId)
        .then(() =>
          Promise.all([
            client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.lists] }),
            client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.unread] }),
            client.invalidateQueries({
              queryKey: [tenantId, ...inboxKeys.conversation(conversationId)],
              exact: true,
            }),
          ]),
        )
        // A failure leaves the chat unread, and the next change tries again.
        .catch(() => undefined);
    };
    const timer = setTimeout(mark, 800);
    window.addEventListener('focus', mark);
    document.addEventListener('visibilitychange', mark);
    return () => {
      done = true;
      clearTimeout(timer);
      window.removeEventListener('focus', mark);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [tenantId, conversationId, unreadCount, client]);
}

// ------------------------------------------------------------------ the browser's permission

export type DesktopPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function desktopPermission(): DesktopPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

/** Asks the browser for permission; the browser shows its own prompt. */
export async function askDesktopPermission(): Promise<DesktopPermission> {
  if (desktopPermission() === 'unsupported') return 'unsupported';
  try {
    return await window.Notification.requestPermission();
  } catch {
    return desktopPermission();
  }
}

/** The browser's permission, read again whenever the person comes back to the page. */
export function useDesktopPermission(): [DesktopPermission, () => Promise<void>] {
  const [permission, setPermission] = useState<DesktopPermission>(desktopPermission);
  useEffect(() => {
    const refresh = () => setPermission(desktopPermission());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const ask = async () => setPermission(await askDesktopPermission());
  return [permission, ask];
}

/** Shows a desktop alert; clicking it brings this window forward and calls `onOpen`. */
export function showDesktopAlert(
  alert: { title: string; body: string; tag: string },
  onOpen: () => void,
): void {
  if (desktopPermission() !== 'granted') return;
  try {
    const shown = new window.Notification(alert.title, {
      body: alert.body,
      // One alert per chat: a newer one replaces the older instead of stacking.
      tag: alert.tag,
      silent: true,
    });
    shown.onclick = () => {
      window.focus();
      onOpen();
      shown.close();
    };
  } catch {
    // Some browsers refuse to build one outside a service worker; the sound and badge remain.
  }
}
