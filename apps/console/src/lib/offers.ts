/**
 * Hand-offs offered to one person at a time (HNV-10-03, HNV-10-06, H02): the chats offered to me,
 * accepting and declining them, and the team and per-person settings that decide who is offered
 * what. The list lives under the inbox lists, so every live inbox change reloads it.
 */
import type * as C from '@hamnivo/contracts';
import { useEffect, useState } from 'react';
import { accessKeys } from './access';
import { api } from './api';
import { inboxKeys } from './inbox';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type OfferList = C.OfferList;
export type InboxOffer = C.InboxOffer;
export type OfferDeclineReason = C.OfferDeclineReason;
export type RoutingProfile = C.RoutingProfile;
export type RoutingProfileList = C.RoutingProfileList;
export type TeamAssignmentMode = C.TeamAssignmentMode;
export type LanguageSlice = C.LanguageSlice;

export const OFFER_DECLINE_REASONS: readonly OfferDeclineReason[] = [
  'at_capacity',
  'not_my_area',
  'going_offline',
  'other',
];

/** The language slices a person can answer in, in the order Studio lists them. */
export const LANGUAGE_SLICES: readonly LanguageSlice[] = [
  'en',
  'ar',
  'hi',
  'ur',
  'hinglish',
  'roman-urdu',
];

export const offerKeys = {
  mine: [...inboxKeys.lists, 'offers'] as const,
  profiles: ['routing-profiles'] as const,
};

/** The chats offered to me now, soonest to run out first. */
export function useMyOffers(enabled: boolean) {
  return useStudioQuery<OfferList>(offerKeys.mine, '/v1/inbox/offers', { enabled });
}

const offerPath = (offerId: string, action: 'accept' | 'decline') =>
  `/v1/inbox/offers/${encodeURIComponent(offerId)}/${action}`;

export function useAcceptOffer() {
  return useStudioMutation(
    (offerId: string, tenant) =>
      api<C.OfferDecisionResult>(offerPath(offerId, 'accept'), { method: 'POST', tenant }),
    [inboxKeys.all],
  );
}

export function useDeclineOffer() {
  return useStudioMutation(
    (vars: { offerId: string; reason: OfferDeclineReason; note?: string }, tenant) =>
      api<C.OfferDecisionResult>(offerPath(vars.offerId, 'decline'), {
        method: 'POST',
        tenant,
        body: { reason: vars.reason, ...(vars.note ? { note: vars.note } : {}) },
      }),
    // Going offline changes my status too.
    [inboxKeys.all],
  );
}

const secondsUntil = (expiresAt: string) =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));

/** Seconds left until `expiresAt`, never below zero, ticking every second while mounted. */
export function useSecondsLeft(expiresAt: string): number {
  const [seconds, setSeconds] = useState(() => secondsUntil(expiresAt));
  useEffect(() => {
    setSeconds(secondsUntil(expiresAt));
    const timer = window.setInterval(() => setSeconds(secondsUntil(expiresAt)), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  return seconds;
}

/** "0:42", "1:05": what is left of an offer. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ settings

export function useRoutingProfiles() {
  const { can } = useTenant();
  return useStudioQuery<RoutingProfileList>(offerKeys.profiles, '/v1/admin/routing-profiles', {
    enabled: can('members.read'),
  });
}

export function useSaveRoutingProfile() {
  return useStudioMutation(
    (
      vars: { staffMemberId: string; languages: LanguageSlice[]; maxOpenChats: number | null },
      tenant,
    ) =>
      api<RoutingProfile>(`/v1/admin/routing-profiles/${encodeURIComponent(vars.staffMemberId)}`, {
        method: 'PUT',
        tenant,
        body: { languages: vars.languages, maxOpenChats: vars.maxOpenChats },
      }),
    [offerKeys.profiles],
  );
}

export function useUpdateTeam(teamId: string) {
  return useStudioMutation(
    (
      body: { name?: string; assignmentMode?: TeamAssignmentMode; offerTimeoutSeconds?: number },
      tenant,
    ) =>
      api<C.Team>(`/v1/admin/teams/${encodeURIComponent(teamId)}`, {
        method: 'PATCH',
        tenant,
        body,
      }),
    [accessKeys.teams],
  );
}

/** A typed open-chat limit: null for none, a number from 1 to 50, or undefined when invalid. */
export function parseLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= 50 ? value : undefined;
}

/** Typed seconds to accept: a whole number from 15 to 600, or undefined when invalid. */
export function parseTimeout(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 15 && value <= 600 ? value : undefined;
}
