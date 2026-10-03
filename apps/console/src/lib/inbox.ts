/**
 * The staff inbox (H01–H17): API shapes, queries, changes and the live stream. Every request goes
 * to the gateway with the staff cookie and the tenant header; the gateway checks each one against
 * the person's grants, so what Studio shows is only ever a view of what they may see.
 */
import type * as C from '@hamnivo/contracts';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, newIdempotencyKey } from './api';
import { API_BASE } from './config';
import { withReauth } from './reauth';
import { useTenant } from './tenant';

export type InboxConversation = C.InboxConversation;
export type InboxDetail = C.InboxConversationDetail;
export type InboxPage = C.InboxPage;
export type InboxCounts = C.InboxCounts;
export type InboxMessage = C.InboxMessage;
export type InboxMessagePage = C.InboxMessagePage;
export type DraftsView = C.DraftsView;
export type StaffDraft = C.StaffDraft;
export type OutgoingMessage = C.OutgoingMessage;
export type DraftLane = C.DraftLane;
export type SavedReply = C.SavedReply;
export type CustomerContext = C.CustomerContext;
export type ConversationTags = C.ConversationTags;
export type ConversationFields = C.ConversationFields;
export type FieldDefinition = C.CustomFieldDefinition;
export type AssigneeOptions = C.AssigneeOptions;
export type CopilotSuggestion = C.CopilotSuggestion;
export type MessageTranslation = C.MessageTranslation;
export type ConversationReview = C.ConversationReview;
export type ConversationLink = C.ConversationLink;
export type BulkResult = C.BulkResult;
export type SearchResult = C.InboxSearchResult;
export type PresenceEntry = C.PresenceEntry;
export type InboxQueue = C.InboxQueue;
export type FieldValue = string | number | boolean | null;

export const QUEUES = ['mine', 'unassigned', 'ai', 'team', 'all'] as const;
export const STATUSES = ['active', 'snoozed', 'resolved', 'all'] as const;
export const CHANNELS = ['chat', 'email', 'whatsapp', 'sms', 'other'] as const;
export type StatusFilter = (typeof STATUSES)[number];
export type ChannelFilter = (typeof CHANNELS)[number];

/** The inbox's place in the address bar, so a view can be shared and survives a reload. */
export interface InboxSearch {
  queue?: InboxQueue;
  status?: StatusFilter;
  brand?: string;
  channel?: ChannelFilter;
  language?: string;
  tag?: string;
  q?: string;
}

export const inboxKeys = {
  all: ['inbox'] as const,
  /** How many chats need this person, for the tab title. */
  unread: ['inbox', 'unread'] as const,
  /** This person's alert sounds and availability. */
  preferences: ['inbox', 'preferences'] as const,
  lists: ['inbox', 'list'] as const,
  list: (search: InboxSearch) => ['inbox', 'list', search] as const,
  search: (q: string) => ['inbox', 'search', q] as const,
  conversation: (id: string) => ['inbox', 'conversation', id] as const,
  part: (id: string, part: string, ...rest: unknown[]) =>
    ['inbox', 'conversation', id, part, ...rest] as const,
};

const path = (id: string, rest = '') => `/v1/inbox/conversations/${encodeURIComponent(id)}${rest}`;

/** Live updates arrive over the stream; while it is down, views poll instead. */
let pollWhileOffline: number | false = false;
const pollListeners = new Set<() => void>();
export function setPolling(interval: number | false) {
  if (pollWhileOffline === interval) return;
  pollWhileOffline = interval;
  for (const listener of pollListeners) listener();
}
function usePolling(): number | false {
  const [value, setValue] = useState(pollWhileOffline);
  useEffect(() => {
    const listener = () => setValue(pollWhileOffline);
    pollListeners.add(listener);
    return () => {
      pollListeners.delete(listener);
    };
  }, []);
  return value;
}

export function useInboxList(search: InboxSearch, pageSize = 25) {
  const { tenantId, can } = useTenant();
  const polling = usePolling();
  return useInfiniteQuery({
    queryKey: [tenantId, ...inboxKeys.list(search), pageSize],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ limit: String(pageSize) });
      query.set('queue', search.queue ?? 'all');
      query.set('status', search.status ?? 'active');
      if (search.brand) query.set('brandId', search.brand);
      if (search.channel) query.set('channel', search.channel);
      if (search.language) query.set('language', search.language);
      if (search.tag) query.set('label', search.tag);
      if (pageParam) query.set('cursor', pageParam);
      return api<InboxPage>(`/v1/inbox/conversations?${query}`, { tenant: tenantId, signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { studio: true },
    enabled: can('conversations.read'),
    refetchInterval: polling,
  });
}

/** Search pages: customers come with the first page; later pages add older message hits. */
export function useInboxSearch(q: string) {
  const { tenantId, can } = useTenant();
  const term = q.trim();
  return useInfiniteQuery({
    queryKey: [tenantId, ...inboxKeys.search(term)],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ q: term });
      if (pageParam) query.set('cursor', pageParam);
      return api<SearchResult>(`/v1/inbox/search?${query}`, { tenant: tenantId, signal });
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { studio: true },
    enabled: can('conversations.read') && term.length >= 2,
  });
}

export function useConversation(id: string) {
  const { tenantId } = useTenant();
  const polling = usePolling();
  return useQuery({
    queryKey: [tenantId, ...inboxKeys.conversation(id)],
    queryFn: ({ signal }) => api<InboxDetail>(path(id), { tenant: tenantId, signal }),
    meta: { studio: true },
    refetchInterval: polling,
  });
}

export function useMessages(id: string) {
  const { tenantId } = useTenant();
  const polling = usePolling();
  return useInfiniteQuery({
    queryKey: [tenantId, ...inboxKeys.part(id, 'messages')],
    queryFn: ({ pageParam, signal }) =>
      api<InboxMessagePage>(
        path(id, `/messages${pageParam ? `?${new URLSearchParams({ before: pageParam })}` : ''}`),
        { tenant: tenantId, signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.olderCursor ?? undefined,
    meta: { studio: true },
    refetchInterval: polling,
  });
}

/** Messages oldest first, from the pages loaded so far (each page is newest first). */
export function chronological(data: InfiniteData<InboxMessagePage> | undefined): InboxMessage[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: InboxMessage[] = [];
  for (const page of [...data.pages].reverse()) {
    for (const message of [...page.items].reverse()) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      out.push(message);
    }
  }
  return out;
}

function useConversationQuery<T>(id: string, part: string, rest: string, enabled = true) {
  const { tenantId } = useTenant();
  return useQuery({
    queryKey: [tenantId, ...inboxKeys.part(id, part, rest)],
    queryFn: ({ signal }) => api<T>(path(id, rest), { tenant: tenantId, signal }),
    meta: { studio: true },
    enabled,
  });
}

export const useDrafts = (id: string) => useConversationQuery<DraftsView>(id, 'drafts', '/drafts');
export const useCustomer = (id: string) =>
  useConversationQuery<CustomerContext>(id, 'customer', '/customer');
export const useTags = (id: string) => useConversationQuery<ConversationTags>(id, 'tags', '/tags');
export const useFields = (id: string) =>
  useConversationQuery<ConversationFields>(id, 'fields', '/fields');
export const useAssignees = (id: string, enabled: boolean) =>
  useConversationQuery<AssigneeOptions>(id, 'assignees', '/assignees', enabled);
export const useLinks = (id: string) =>
  useConversationQuery<{ items: ConversationLink[] }>(id, 'links', '/links');
export const useReviews = (id: string, enabled: boolean) =>
  useConversationQuery<{ items: ConversationReview[] }>(id, 'reviews', '/reviews', enabled);
export const useSavedReplies = (id: string, q: string, enabled: boolean) =>
  useConversationQuery<{ items: SavedReply[] }>(
    id,
    'saved-replies',
    `/saved-replies${q.trim() ? `?${new URLSearchParams({ q: q.trim() })}` : ''}`,
    enabled,
  );

/**
 * A change to one conversation. It reloads the conversation, its list rows and the listed parts
 * afterwards, whether it worked or not (a refusal usually means the view was out of date).
 */
export function useConversationChange<TVars, TResult>(
  id: string,
  run: (vars: TVars, tenantId: string) => Promise<TResult>,
  parts: readonly string[] = [],
) {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => withReauth(() => run(vars, tenantId)),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({
          queryKey: [tenantId, ...inboxKeys.conversation(id)],
          exact: true,
        }),
        client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.lists] }),
        ...parts.map((part) =>
          client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.part(id, part)] }),
        ),
      ]),
  });
}

export type AssignTarget =
  | { kind: 'me' }
  | { kind: 'staff'; staffMemberId: string }
  | { kind: 'queue' }
  | { kind: 'ai' };

export const assign = (tenantId: string, id: string, to: AssignTarget, expectedEpoch?: number) =>
  api<InboxDetail>(path(id, '/assign'), {
    method: 'POST',
    tenant: tenantId,
    body: { to, ...(expectedEpoch !== undefined ? { expectedEpoch } : {}) },
  });

export const setStatus = (
  tenantId: string,
  id: string,
  body: { status: 'open' | 'resolved' | 'snoozed'; snoozedUntil?: string; expectedEpoch?: number },
) => api<InboxDetail>(path(id, '/status'), { method: 'POST', tenant: tenantId, body });

export interface SendInput {
  clientMessageId: string;
  text: string;
  lane: DraftLane;
  expectedEpoch?: number;
  suggestionId?: string;
}

export const sendMessage = (tenantId: string, id: string, input: SendInput) =>
  api<{ messageId: string; status: 'accepted' | 'duplicate' }>(
    `/v1/conversations/${encodeURIComponent(id)}/messages`,
    {
      method: 'POST',
      tenant: tenantId,
      body: {
        clientMessageId: input.clientMessageId,
        text: input.text,
        visibility: input.lane,
        clearDraft: true,
        ...(input.lane === 'public' && input.expectedEpoch !== undefined
          ? { expectedEpoch: input.expectedEpoch }
          : {}),
        ...(input.suggestionId ? { suggestionId: input.suggestionId } : {}),
      },
    },
  );

export const saveDraft = (
  tenantId: string,
  id: string,
  lane: DraftLane,
  text: string,
  baseRevision: number | undefined,
) =>
  text === ''
    ? api<void>(path(id, `/drafts/${lane}`), { method: 'DELETE', tenant: tenantId }).then(
        () => null,
      )
    : api<StaffDraft>(path(id, `/drafts/${lane}`), {
        method: 'PUT',
        tenant: tenantId,
        body: { text, ...(baseRevision !== undefined ? { baseRevision } : {}) },
      });

export const discardOutgoing = (tenantId: string, id: string, clientMessageId: string) =>
  api<void>(path(id, `/outgoing/${clientMessageId}`), { method: 'DELETE', tenant: tenantId });

export const newClientId = newIdempotencyKey;

/** Says who is looking at or typing in the conversation; best effort, never blocks the page. */
export function sendPresence(
  tenantId: string,
  id: string,
  state: 'viewing' | 'typing' | 'left',
  lane?: DraftLane,
) {
  void fetch(`${API_BASE}${path(id, '/presence')}`, {
    method: 'POST',
    credentials: 'include',
    keepalive: state === 'left',
    headers: { 'content-type': 'application/json', 'x-hamnivo-tenant': tenantId },
    body: JSON.stringify({ state, ...(lane ? { lane } : {}) }),
  }).catch(() => undefined);
}

/** Whether the browser says it is offline (drafts then stay in this browser until it is back). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

// ------------------------------------------------------------------ local draft copies

const draftKey = (tenantId: string, id: string, lane: DraftLane) =>
  `hamnivo.studio.draft.${tenantId}.${id}.${lane}`;

/** A copy of unsaved text in this browser, for when the network is gone. */
export function localDraft(tenantId: string, id: string, lane: DraftLane) {
  return {
    read(): { text: string; at: number } | null {
      try {
        const raw = window.localStorage.getItem(draftKey(tenantId, id, lane));
        if (!raw) return null;
        const value = JSON.parse(raw) as { text?: unknown; at?: unknown };
        return typeof value.text === 'string' && typeof value.at === 'number'
          ? { text: value.text, at: value.at }
          : null;
      } catch {
        return null;
      }
    },
    write(text: string) {
      try {
        if (text) {
          window.localStorage.setItem(
            draftKey(tenantId, id, lane),
            JSON.stringify({ text, at: Date.now() }),
          );
        } else window.localStorage.removeItem(draftKey(tenantId, id, lane));
      } catch {
        // Storage can be blocked; the server copy still saves.
      }
    },
  };
}
