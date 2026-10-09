/**
 * Channels (Settings, ADR 0013): the email, WhatsApp and Telegram inboxes of a brand's Chatwoot
 * account, and the requests that list them, look for new ones and change one. A change shows at
 * once (the card is patched in the cache) and is put back if the gateway refuses it; the list is
 * read again afterwards, so a change saved here but not in Chatwoot still shows as saved.
 */
import type * as C from '@hamnivo/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useStudioQuery } from './queries';
import { withReauth } from './reauth';
import { useTenant } from './tenant';
import type { Items, Team } from './types';

export type ChannelInbox = C.ChannelInbox;
export type ChannelKind = C.ChannelKind;
export type ChannelStatus = ChannelInbox['status'];
export type ChannelChange = C.UpdateChannelRequest;

export const CHANNEL_KINDS: readonly ChannelKind[] = ['email', 'whatsapp', 'telegram', 'other'];

export const channelKeys = {
  list: (brandId: string) => ['channels', brandId],
} as const;

const listPath = (brandId: string) => `/v1/admin/brands/${encodeURIComponent(brandId)}/channels`;

export function useChannels(brandId: string) {
  const { can } = useTenant();
  return useStudioQuery<Items<ChannelInbox>>(channelKeys.list(brandId), listPath(brandId), {
    enabled: can('integrations.manage'),
  });
}

/** Channels of the brand first, then the ones its Chatwoot account has that answer for no brand. */
export function orderChannels(items: readonly ChannelInbox[]): ChannelInbox[] {
  return [...items.filter((c) => c.brandId !== null), ...items.filter((c) => c.brandId === null)];
}

/** How many channels a check found that the list did not have before. */
export function newChannelCount(
  before: readonly ChannelInbox[] | undefined,
  after: readonly ChannelInbox[],
): number {
  const known = new Set((before ?? []).map((channel) => channel.id));
  return after.filter((channel) => !known.has(channel.id)).length;
}

/** The channel as it will be once the change is saved (what the card shows while it saves). */
export function applyChange(
  channel: ChannelInbox,
  change: ChannelChange,
  now = new Date().toISOString(),
): ChannelInbox {
  const next = { ...channel };
  if (change.brandId !== undefined) next.brandId = change.brandId;
  if (change.aiAnswers !== undefined) next.aiAnswers = change.aiAnswers;
  if (change.defaultTeamId !== undefined) next.defaultTeamId = change.defaultTeamId;
  if (change.paused === true) {
    next.status = 'paused';
    next.pausedAt = channel.pausedAt ?? (now as ChannelInbox['pausedAt']);
  } else if (change.paused === false) {
    next.pausedAt = null;
    next.status = channel.problem ? 'needs_attention' : 'connected';
  }
  return next;
}

const replace = (
  list: Items<ChannelInbox> | undefined,
  id: string,
  update: (channel: ChannelInbox) => ChannelInbox,
): Items<ChannelInbox> | undefined =>
  list
    ? { items: list.items.map((channel) => (channel.id === id ? update(channel) : channel)) }
    : list;

/** "Check for new channels": the list as Chatwoot has it now, and how many of them are new. */
export function useFindChannels(brandId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: async () => {
      const before = client.getQueryData<Items<ChannelInbox>>(key);
      const found = await withReauth(() =>
        api<Items<ChannelInbox>>(`${listPath(brandId)}/find`, { method: 'POST', tenant: tenantId }),
      );
      return { found, added: newChannelCount(before?.items, found.items) };
    },
    onSuccess: ({ found }) => client.setQueryData(key, found),
  });
}

/** Changes one channel: the card shows the change at once and goes back if it is refused. */
export function useUpdateChannel(brandId: string, channelId: string) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  const key = [tenantId, ...channelKeys.list(brandId)];
  return useMutation({
    mutationFn: (change: ChannelChange) =>
      withReauth(() =>
        api<ChannelInbox>(`/v1/admin/channels/${encodeURIComponent(channelId)}`, {
          method: 'PUT',
          body: change,
          tenant: tenantId,
        }),
      ),
    onMutate: async (change) => {
      await client.cancelQueries({ queryKey: key });
      const before = client
        .getQueryData<Items<ChannelInbox>>(key)
        ?.items.find((channel) => channel.id === channelId);
      client.setQueryData<Items<ChannelInbox>>(key, (list) =>
        replace(list, channelId, (channel) => applyChange(channel, change)),
      );
      return { before };
    },
    onError: (_error, _change, context) => {
      const before = context?.before;
      if (before) {
        client.setQueryData<Items<ChannelInbox>>(key, (list) =>
          replace(list, channelId, () => before),
        );
      }
    },
    onSuccess: (saved) => {
      client.setQueryData<Items<ChannelInbox>>(key, (list) =>
        replace(list, channelId, () => saved),
      );
    },
    // Read again either way: a change can be saved here while Chatwoot did not take it yet.
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

/** Teams that can take a brand's conversations: those of its workspace and the shared ones. */
export function teamsForBrand(
  teams: readonly Team[] | undefined,
  workspaceId: string | undefined,
): Team[] {
  return (teams ?? [])
    .filter((team) => team.status === 'active')
    .filter((team) => !workspaceId || team.workspaceId === null || team.workspaceId === workspaceId)
    .sort((a, b) => a.name.localeCompare(b.name));
}
