import {
  EventStream,
  HamnivoClient,
  type HamnivoClientOptions,
  Outbox,
  type OutgoingAttachment,
  type OutgoingMessage,
  type StreamHandlers,
  type StreamOptions,
  type StreamStatus,
} from '@hamnivo/client';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

export type {
  HamnivoClientOptions,
  OutgoingAttachment,
  OutgoingMessage,
  StreamHandlers,
  StreamOptions,
  StreamStatus,
};

/**
 * Hooks for building your own chat on @hamnivo/client, the headless SDK. They keep the objects of
 * the SDK alive for as long as a component needs them, and show their state. They need
 * @hamnivo/client installed next to this package. For the ready-made chat, use HamnivoChat.
 */

/** One connection per client, so a component that renders twice does not open two sessions. */
const connections = new WeakMap<HamnivoClient, Promise<unknown>>();

function connectOnce(client: HamnivoClient): Promise<unknown> {
  let connection = connections.get(client);
  if (!connection) {
    connection = client.connect();
    connections.set(client, connection);
    // A connection that failed may be tried again.
    connection.catch(() => connections.delete(client));
  }
  return connection;
}

export interface UseHamnivoClient {
  client: HamnivoClient;
  /** connecting until the visitor's session is open, and error when it could not be opened. */
  status: 'connecting' | 'ready' | 'error';
  /** The session now: null until it opens and after a reset. */
  session: HamnivoClient['current'];
  error: Error | null;
  /** Tries to open the session again after an error. */
  retry: () => void;
}

/**
 * A HamnivoClient for these options, with its session opened. It is made again only when the
 * apiBase, widgetId, hostOrigin, locale, storage or fetch change, so keep storage and fetch stable.
 * hostOrigin is the page's own origin when you leave it out: it must be one of the brand's allowed
 * websites.
 */
export function useHamnivoClient(options: HamnivoClientOptions): UseHamnivoClient {
  const { apiBase, widgetId, hostOrigin, locale, storage, fetch, refreshLeadMs } = options;
  const client = useMemo(
    () =>
      new HamnivoClient({
        apiBase,
        widgetId,
        hostOrigin: hostOrigin ?? (typeof location === 'undefined' ? undefined : location.origin),
        ...(locale ? { locale } : {}),
        ...(storage ? { storage } : {}),
        ...(fetch ? { fetch } : {}),
        ...(refreshLeadMs !== undefined ? { refreshLeadMs } : {}),
      }),
    [apiBase, widgetId, hostOrigin, locale, storage, fetch, refreshLeadMs],
  );

  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<{
    client: HamnivoClient;
    status: 'connecting' | 'ready' | 'error';
    error: Error | null;
  }>({ client, status: 'connecting', error: null });

  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt is how retry runs this again
  useEffect(() => {
    let cancelled = false;
    setConnection((previous) =>
      previous.client === client && previous.status === 'connecting'
        ? previous
        : { client, status: 'connecting', error: null },
    );
    connectOnce(client).then(
      () => {
        if (!cancelled) setConnection({ client, status: 'ready', error: null });
      },
      (error: Error) => {
        if (!cancelled) setConnection({ client, status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, attempt]);

  const session = useSyncExternalStore(
    useCallback((notify: () => void) => client.onSession(() => notify()), [client]),
    () => client.current,
    () => null,
  );
  const retry = useCallback(() => {
    connections.delete(client);
    setAttempt((count) => count + 1);
  }, [client]);

  const current = connection.client === client;
  return {
    client,
    status: current ? connection.status : 'connecting',
    session,
    error: current ? connection.error : null,
    retry,
  };
}

export interface UseOutbox {
  /** What the visitor typed in this conversation and Hamnivo has not shown back yet, in order. */
  messages: readonly OutgoingMessage[];
  /** Queues a message. It is sent once, in order, and kept across reloads until it is accepted. */
  send: (text: string, attachments?: readonly OutgoingAttachment[]) => OutgoingMessage;
  /** Sends a failed message again. It keeps its id, so Hamnivo never stores it twice. */
  retry: (clientMessageId: string) => void;
  /** Takes back a message that is not on its way, for example to edit it. */
  remove: (clientMessageId: string) => OutgoingMessage | null;
  /** Drops an accepted message once your list shows the real one from the stream. */
  settle: (clientMessageId: string) => void;
  /** Tries the queue now. */
  flush: () => void;
}

/**
 * The messages the visitor typed in one conversation, with their honest states: queued, sending,
 * accepted or failed. The outbox lives as long as the component, and its queue survives a reload.
 */
export function useOutbox(client: HamnivoClient | null, conversationId: string | null): UseOutbox {
  const [messages, setMessages] = useState<readonly OutgoingMessage[]>([]);
  const outbox = useRef<Outbox | null>(null);

  useEffect(() => {
    if (!client || !conversationId) {
      setMessages([]);
      return;
    }
    const made = new Outbox(client, conversationId);
    outbox.current = made;
    const stop = made.subscribe(setMessages);
    return () => {
      stop();
      made.dispose();
      if (outbox.current === made) outbox.current = null;
    };
  }, [client, conversationId]);

  // The same functions on every render. They find the outbox that is current when they are called.
  const controls = useMemo(() => {
    const need = (): Outbox => {
      if (!outbox.current) throw new Error('There is no conversation to send to yet.');
      return outbox.current;
    };
    return {
      send: (text: string, attachments?: readonly OutgoingAttachment[]) =>
        need().enqueue(text, attachments),
      retry: (id: string) => need().retry(id),
      remove: (id: string) => need().remove(id),
      settle: (id: string) => need().settle(id),
      flush: () => need().flush(),
    };
  }, []);
  return { messages, ...controls };
}

/**
 * Follows one conversation live. Events arrive in order, once each; the stream reconnects where it
 * stopped, renews the session when it expires, and calls onResync when you must reload the history.
 * The handlers can be new functions on every render: the latest ones are called. `after`, the last
 * sequence you have already shown, is read when the stream starts.
 */
export function useConversationStream(
  client: HamnivoClient | null,
  conversationId: string | null,
  handlers: StreamHandlers,
  options: StreamOptions = {},
): { status: StreamStatus } {
  const [status, setStatus] = useState<StreamStatus>('closed');
  const latest = useRef({ handlers, options });
  useEffect(() => {
    latest.current = { handlers, options };
  });

  useEffect(() => {
    if (!client || !conversationId) {
      setStatus('closed');
      return;
    }
    setStatus('connecting');
    const stream = new EventStream(
      client,
      conversationId,
      {
        onEvent: (event) => latest.current.handlers.onEvent(event),
        onResync: () => latest.current.handlers.onResync?.(),
        onError: (error) => latest.current.handlers.onError?.(error),
        onStatus: (next) => {
          setStatus(next);
          latest.current.handlers.onStatus?.(next);
        },
      },
      latest.current.options,
    );
    return () => stream.close();
  }, [client, conversationId]);

  return useMemo(() => ({ status }), [status]);
}
