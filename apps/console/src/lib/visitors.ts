/**
 * Website visitors in Studio: the visitor card beside a conversation, the live visitors page and
 * each brand's tracking settings. The gateway decides what a person may see (only brands their role
 * reaches) and whether a brand notes pages at all; this file only asks for it and words it.
 */
import type * as C from '@hamnivo/contracts';
import { api } from './api';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type ConversationVisitor = C.ConversationVisitor;
export type VisitorCard = C.VisitorCard;
export type LiveVisitor = C.LiveVisitor;
export type LiveVisitorList = C.LiveVisitorList;
export type VisitorSettings = C.VisitorSettings;
export type VisitorSettingsView = C.VisitorSettingsView;
export type DeviceType = C.DeviceType;

export const visitorKeys = {
  conversation: (id: string) => ['visitors', 'conversation', id] as const,
  live: (brandId: string) => ['visitors', 'live', brandId] as const,
  settings: (brandId: string) => ['visitors', 'settings', brandId] as const,
};

/** How often the card and the live list ask again: a visitor's page changes while staff look. */
export const CARD_REFRESH_MS = 30_000;
export const LIVE_REFRESH_MS = 10_000;

const path = (id: string) => `/v1/inbox/conversations/${encodeURIComponent(id)}/visitor`;

/** The pages, device, country and visits of the browser a customer chatted from. */
export function useConversationVisitor(conversationId: string) {
  const { can } = useTenant();
  return useStudioQuery<ConversationVisitor>(
    visitorKeys.conversation(conversationId),
    path(conversationId),
    {
      enabled: can('conversations.read'),
      refetchInterval: CARD_REFRESH_MS,
    },
  );
}

/** Who is on the websites of the brands this person can see right now. */
export function useLiveVisitors(brandId: string) {
  const { can } = useTenant();
  const query = brandId ? `?${new URLSearchParams({ brandId })}` : '';
  return useStudioQuery<LiveVisitorList>(visitorKeys.live(brandId), `/v1/visitors/live${query}`, {
    enabled: can('conversations.read'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

/** Sends an invitation to chat to one visitor; it shows next to the chat button within seconds. */
export function useInviteVisitor() {
  return useStudioMutation<{ visitorId: string; message: string }, C.VisitorInviteResult>(
    ({ visitorId, message }, tenant) =>
      api<C.VisitorInviteResult>(`/v1/visitors/${encodeURIComponent(visitorId)}/invite`, {
        method: 'POST',
        tenant,
        body: { message },
      }),
  );
}

export function useVisitorSettings(brandId: string, enabled: boolean) {
  return useStudioQuery<VisitorSettingsView>(
    visitorKeys.settings(brandId),
    `/v1/admin/brands/${encodeURIComponent(brandId)}/visitor-settings`,
    { enabled },
  );
}

export function useSaveVisitorSettings(brandId: string) {
  return useStudioMutation<VisitorSettings, VisitorSettingsView>(
    (settings, tenant) =>
      api<VisitorSettingsView>(`/v1/admin/brands/${encodeURIComponent(brandId)}/visitor-settings`, {
        method: 'PUT',
        tenant,
        body: settings,
      }),
    [visitorKeys.settings(brandId)],
  );
}

// ------------------------------------------------------------------ wording

/** "5 min" or "1 hr 5 min" in the interface language; null for under a minute. */
export function formatSpan(seconds: number, locale: string): string | null {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return null;
  const unit = (value: number, name: 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(
      value,
    );
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [
    hours > 0 ? unit(hours, 'hour') : null,
    rest > 0 || hours === 0 ? unit(rest, 'minute') : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A country's name in the interface language, or its code when the browser does not know it. */
export function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The part of a page address after the website: `/pricing`, or `/` for the home page. */
export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

/** "Phone · Safari 17 · iOS 17": the kind of device, then the browser and the system when known. */
export function deviceLine(
  device: { type: DeviceType; browser: string | null; os: string | null },
  kind: string,
): string {
  return [kind, device.browser, device.os].filter(Boolean).join(' · ');
}
