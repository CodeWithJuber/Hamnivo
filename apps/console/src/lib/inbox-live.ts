/**
 * The live connection to the inbox. One connection serves the whole tab: the inbox page uses it to
 * keep its lists current, and the alerts (sounds, desktop notifications, the count on the tab)
 * listen on it from every Studio page. The gateway's staff stream says which visible conversations
 * changed, who is viewing or typing, what the customer is typing, and which alerts this person
 * should hear; Studio reloads what changed through the API. While the stream is down, views poll
 * every 15 seconds, and a reconnect reloads everything once in case something was missed.
 */
import type * as C from '@hamnivo/contracts';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { API_BASE } from './config';
import { type InboxDetail, inboxKeys, type PresenceEntry, setPolling } from './inbox';
import { useTenant } from './tenant';

export type StreamState = 'connecting' | 'open' | 'reconnecting' | 'offline';
export type InboxAlert = C.InboxAlertEvent;

export interface ServerEvent {
  event: string;
  data: string;
}

/** Splits a Server-Sent Events body into events (comments and ids are not used here). */
export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ServerEvent) => void,
  onActivity: () => void,
): Promise<void> {
  const reader = body
    .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
    .getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    onActivity();
    buffer += value;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith(':')) continue;
        const at = line.indexOf(':');
        const field = at < 0 ? line : line.slice(0, at);
        const text = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
        if (field === 'event') event = text;
        else if (field === 'data') data.push(text);
      }
      if (data.length > 0) onEvent({ event, data: data.join('\n') });
    }
  }
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

/**
 * The gateway repeats "typing" about every three seconds while a customer types. Without one for
 * this long, the line goes away, so a missed "stopped" never leaves it on the screen.
 */
export const TYPING_LINE_MS = 10_000;

/** Every kind of alert the gateway sends; a kind added there must be added here (exhaustive). */
const ALERT_KINDS: Record<C.InboxAlertKind, true> = {
  chat_offered: true,
  sla_overdue: true,
  sla_overdue_lead: true,
  chat_waiting: true,
  assigned: true,
  customer_message: true,
};

/** An alert event from the stream, or null when it is not one (nothing is guessed). */
export function parseAlert(payload: Record<string, unknown>): InboxAlert | null {
  const { kind, conversationId, customerName, preview, at } = payload;
  if (
    typeof kind !== 'string' ||
    !Object.hasOwn(ALERT_KINDS, kind) ||
    typeof conversationId !== 'string' ||
    typeof customerName !== 'string' ||
    typeof at !== 'string' ||
    (preview !== null && typeof preview !== 'string')
  ) {
    return null;
  }
  return {
    type: 'alert',
    kind: kind as C.InboxAlertKind,
    conversationId: conversationId as InboxAlert['conversationId'],
    customerName,
    preview: preview as string | null,
    at: at as InboxAlert['at'],
  };
}

/**
 * What each event of the stream does. Kept apart from the connection so it can be tested with a
 * query client and a clock alone.
 */
export function inboxEventHandler(
  client: QueryClient,
  tenantId: string,
  hooks: { alert: (alert: InboxAlert) => void; authExpired: () => void },
) {
  const typing = new Map<string, ReturnType<typeof setTimeout>>();
  const setTyping = (id: string, value: boolean) =>
    client.setQueryData<InboxDetail>([tenantId, ...inboxKeys.conversation(id)], (detail) =>
      detail && detail.customerTyping !== value ? { ...detail, customerTyping: value } : detail,
    );

  /** Reloads the lists, the unread count and the named conversations (all of them when empty). */
  const changed = (ids: string[]) => {
    void client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.lists] });
    void client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.unread] });
    for (const id of ids) {
      void client.invalidateQueries({ queryKey: [tenantId, ...inboxKeys.conversation(id)] });
    }
  };

  return {
    changed,
    handle({ event, data }: ServerEvent) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event === 'inbox.changed' && Array.isArray(payload.conversationIds)) {
        changed(payload.conversationIds.filter((id): id is string => typeof id === 'string'));
      } else if (event === 'presence' && typeof payload.conversationId === 'string') {
        const viewers = Array.isArray(payload.viewers) ? (payload.viewers as PresenceEntry[]) : [];
        client.setQueryData<InboxDetail>(
          [tenantId, ...inboxKeys.conversation(payload.conversationId)],
          (detail) => (detail ? { ...detail, presence: viewers } : detail),
        );
      } else if (event === 'customer_typing' && typeof payload.conversationId === 'string') {
        const id = payload.conversationId;
        const timer = typing.get(id);
        if (timer) clearTimeout(timer);
        typing.delete(id);
        const on = payload.typing === true;
        setTyping(id, on);
        if (on) {
          typing.set(
            id,
            setTimeout(() => {
              typing.delete(id);
              setTyping(id, false);
            }, TYPING_LINE_MS),
          );
        }
      } else if (event === 'alert') {
        const alert = parseAlert(payload);
        if (alert) hooks.alert(alert);
      } else if (event === 'control' && payload.control === 'auth_expired') {
        // The session ended: asking for "me" again opens the sign-in dialog over the page.
        void client.invalidateQueries({ queryKey: ['me', tenantId] });
        hooks.authExpired();
      }
    },
    dispose() {
      for (const timer of typing.values()) clearTimeout(timer);
      typing.clear();
    },
  };
}

// ------------------------------------------------------------------ one connection per tab

interface Hub {
  tenantId: string;
  client: QueryClient;
  /** Who is using the connection (the inbox page, the alerts). It closes when nobody is. */
  users: number;
  state: StreamState;
  closing: ReturnType<typeof setTimeout> | undefined;
  stop: () => void;
}

let hub: Hub | null = null;
const stateListeners = new Set<() => void>();
const alertListeners = new Set<(alert: InboxAlert) => void>();
const announceState = () => {
  for (const listener of stateListeners) listener();
};

function connect(tenantId: string, client: QueryClient): Hub {
  const self: Hub = {
    tenantId,
    client,
    users: 0,
    state: 'connecting',
    closing: undefined,
    stop: () => undefined,
  };
  const setState = (state: StreamState) => {
    if (self.state === state) return;
    self.state = state;
    if (hub === self) announceState();
  };
  let closed = false;
  let controller: AbortController | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let connectedBefore = false;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    // Heartbeats arrive well within a minute; silence means the connection is gone.
    idle = setTimeout(() => controller?.abort(), 60_000);
  };
  const handler = inboxEventHandler(client, tenantId, {
    alert: (alert) => {
      for (const listener of alertListeners) listener(alert);
    },
    authExpired: () => controller?.abort(),
  });

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const response = await fetch(`${API_BASE}/v1/inbox/events`, {
          headers: { accept: 'text/event-stream', 'x-hamnivo-tenant': tenantId },
          credentials: 'include',
          signal: controller.signal,
        });
        if (response.ok && response.body) {
          attempt = 0;
          setState('open');
          setPolling(false);
          if (connectedBefore) handler.changed([]);
          connectedBefore = true;
          armIdle();
          await readEvents(response.body, handler.handle, armIdle);
        } else if (response.status === 401) {
          void client.invalidateQueries({ queryKey: ['me', tenantId] });
        }
      } catch {
        // Reconnect below.
      }
      if (idle) clearTimeout(idle);
      if (closed) return;
      setState(navigator.onLine === false ? 'offline' : 'reconnecting');
      setPolling(15_000);
      await new Promise((resolve) => setTimeout(resolve, backoff(attempt)));
      attempt += 1;
    }
  };
  void run();
  const online = () => controller?.abort();
  window.addEventListener('online', online);
  self.stop = () => {
    closed = true;
    window.removeEventListener('online', online);
    if (idle) clearTimeout(idle);
    controller?.abort();
    handler.dispose();
    setPolling(false);
  };
  return self;
}

/** Uses the tab's connection (opening it when nobody has); returns the call that lets it go. */
export function retainInboxStream(tenantId: string, client: QueryClient): () => void {
  if (hub && (hub.tenantId !== tenantId || hub.client !== client)) {
    hub.stop();
    hub = null;
  }
  if (!hub) {
    hub = connect(tenantId, client);
    announceState();
  }
  const mine = hub;
  if (mine.closing) {
    clearTimeout(mine.closing);
    mine.closing = undefined;
  }
  mine.users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.users -= 1;
    if (mine.users > 0) return;
    // Moving between pages lets go and takes hold again at once; wait a moment before closing.
    mine.closing = setTimeout(() => {
      mine.closing = undefined;
      if (mine.users > 0) return;
      mine.stop();
      if (hub === mine) {
        hub = null;
        announceState();
      }
    }, 1000);
  };
}

/** Calls `listener` for each alert the stream brings; returns the call that stops listening. */
export function onInboxAlert(listener: (alert: InboxAlert) => void): () => void {
  alertListeners.add(listener);
  return () => {
    alertListeners.delete(listener);
  };
}

const subscribe = (listener: () => void) => {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
};

/** Keeps the inbox current while `enabled`, over the connection the whole tab shares. */
export function useInboxStream(enabled: boolean): StreamState {
  const { tenantId } = useTenant();
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return retainInboxStream(tenantId, client);
  }, [enabled, tenantId, client]);
  return useSyncExternalStore(
    subscribe,
    () => hub?.state ?? 'connecting',
    () => 'connecting',
  );
}

/** Calls `listener` with each alert, for as long as the component is on the page. */
export function useInboxAlertListener(listener: (alert: InboxAlert) => void): void {
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => onInboxAlert((alert) => latest.current(alert)), []);
}
