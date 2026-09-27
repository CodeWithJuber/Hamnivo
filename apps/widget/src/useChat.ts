import {
  EventStream,
  type HamnivoClient,
  Outbox,
  type OutgoingMessage,
  type StreamStatus,
} from '@hamnivo/client';
import type { CustomerConversation, Message, WidgetSession } from '@hamnivo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Connection = StreamStatus | 'idle' | 'offline';

export interface ChatState {
  phase: 'loading' | 'ready' | 'error';
  session: WidgetSession | null;
  conversation: CustomerConversation | null;
  messages: Message[];
  outgoing: readonly OutgoingMessage[];
  connection: Connection;
  error: string | null;
  /** The server's answer to "talk to a person", such as when people are back (W11). */
  handoffNotice: string | null;
}

const byTime = (a: Message, b: Message) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0);

function merge(messages: Message[], incoming: Message): Message[] {
  const without = messages.filter((m) => m.id !== incoming.id);
  return [...without, incoming].sort(byTime);
}

const EMPTY: ChatState = {
  phase: 'loading',
  session: null,
  conversation: null,
  messages: [],
  outgoing: [],
  connection: 'idle',
  error: null,
  handoffNotice: null,
};

const messageOf = (error: unknown) => String((error as Error)?.message ?? error);

/**
 * The visitor's side of one conversation: session, history, live stream and the send outbox.
 * Confirmed messages come only from the server (history or stream); unsent ones from the outbox.
 *
 * The person can change: the website signs a customer in (identify) or out (reset). Such changes
 * run one at a time, and each clears the screen first. Work still running for the previous person
 * (history, a starting conversation, a send) belongs to an older generation and is dropped.
 */
export function useChat(client: HamnivoClient) {
  const [state, setState] = useState<ChatState>(EMPTY);
  const stream = useRef<EventStream | null>(null);
  const outbox = useRef<Outbox | null>(null);
  const attaching = useRef<Promise<void> | null>(null);
  const generation = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** The person whose chats are on screen. */
  const shown = useRef<string | null>(null);

  /** Runs session changes (start, identify, reset) one at a time, in order. */
  const serial = useCallback(<T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(work, work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  /** Stops everything tied to the current person. */
  const detach = useCallback(() => {
    generation.current += 1;
    stream.current?.close();
    stream.current = null;
    outbox.current?.dispose();
    outbox.current = null;
    attaching.current = null;
  }, []);

  const apply = useCallback((event: Record<string, unknown> & { type: string }) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    setState((s) => {
      switch (event.type) {
        case 'message.created':
        case 'message.updated': {
          const message = data.message as Message;
          if (message.clientMessageId) outbox.current?.settle(message.clientMessageId);
          return { ...s, messages: merge(s.messages, message) };
        }
        case 'message.redacted':
          return { ...s, messages: s.messages.filter((m) => m.id !== data.messageId) };
        case 'conversation.updated':
          return s.conversation
            ? {
                ...s,
                conversation: {
                  ...s.conversation,
                  status: data.status as CustomerConversation['status'],
                  responder: data.responder as CustomerConversation['responder'],
                },
              }
            : s;
        case 'conversation.resolved':
          return s.conversation
            ? { ...s, conversation: { ...s.conversation, status: 'resolved', responder: 'none' } }
            : s;
        case 'conversation.reopened':
          return s.conversation ? { ...s, conversation: { ...s.conversation, status: 'open' } } : s;
        default:
          return s;
      }
    });
  }, []);

  const attach = useCallback(
    async (conversation: CustomerConversation, loadHistory: boolean) => {
      const current = generation.current;
      const stale = () => current !== generation.current;
      stream.current?.close();
      outbox.current?.dispose();
      let after = conversation.latestSequence;
      let messages: Message[] = [];
      if (loadHistory) {
        const page = await client.history(conversation.id, { limit: 50 });
        if (stale()) return;
        messages = [...page.items].sort(byTime);
        after = page.latestSequence;
      }
      if (stale()) return;
      setState((s) => ({ ...s, conversation, messages }));
      const box = new Outbox(client, conversation.id);
      outbox.current = box;
      box.subscribe((items) => setState((s) => ({ ...s, outgoing: items })));
      stream.current = new EventStream(
        client,
        conversation.id,
        {
          onEvent: apply,
          onStatus: (connection) => setState((s) => ({ ...s, connection })),
          onResync: () => {
            void client.history(conversation.id, { limit: 50 }).then((page) => {
              if (!stale()) setState((s) => ({ ...s, messages: [...page.items].sort(byTime) }));
            });
          },
          onError: (error) =>
            setState((s) => ({ ...s, error: String((error as Error).message ?? error) })),
        },
        { after },
      );
    },
    [apply, client],
  );

  /** Shows the person behind `session`: their open (or latest) conversation, nothing else. */
  const begin = useCallback(
    async (session: WidgetSession) => {
      detach();
      shown.current = session.principal.id;
      setState({ ...EMPTY, phase: 'ready', session });
      const conversation =
        session.conversations.find((c) => c.status !== 'resolved') ??
        session.conversations[0] ??
        null;
      if (conversation) await attach(conversation, true);
    },
    [attach, detach],
  );

  useEffect(() => {
    let cancelled = false;
    void serial(async () => {
      const session = await client.connect();
      if (!cancelled) await begin(session);
    }).catch((error) => {
      if (!cancelled) setState((s) => ({ ...s, phase: 'error', error: messageOf(error) }));
    });
    const offline = () => setState((s) => ({ ...s, connection: 'offline' }));
    const online = () =>
      setState((s) => ({
        ...s,
        connection: s.connection === 'offline' ? 'reconnecting' : s.connection,
      }));
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      detach();
    };
  }, [begin, client, detach, serial]);

  /** Starts over as a new anonymous visitor after this device forgot the previous one. */
  const startOver = useCallback(async () => {
    try {
      await begin(await client.connect());
    } catch (error) {
      setState({ ...EMPTY, phase: 'error', error: messageOf(error) });
    }
  }, [begin, client]);

  useEffect(() => {
    // The session moved to another person without a sign-in here (for example a renewal after
    // the session was ended elsewhere): show that person, never the previous one's chats.
    const offSession = client.onSession((session) => {
      if (!session || !shown.current || session.principal.id === shown.current) return;
      void serial(async () => {
        if (client.current === session && session.principal.id !== shown.current) {
          await begin(session);
        }
      });
    });
    // Another tab of this website signed the visitor out: forget them in this tab too.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== client.refreshKey || event.newValue !== null || !client.current) return;
      void serial(async () => {
        detach();
        setState(EMPTY);
        client.forget();
        await startOver();
      });
    };
    window.addEventListener('storage', onStorage);
    return () => {
      offSession();
      window.removeEventListener('storage', onStorage);
    };
  }, [begin, client, detach, serial, startOver]);

  /** Signs the visitor in as the customer the website vouches for and shows their own chats. */
  const identify = useCallback(
    (assertion: string) =>
      serial(async () => {
        await begin(await client.identify(assertion));
      }),
    [begin, client, serial],
  );

  /**
   * Forgets the visitor on this device, for example when the website signs the customer out. The
   * screen is cleared first; then the session ends on the server and in this browser, and a new
   * anonymous one starts. Resolves false when the server could not be told (this device has
   * forgotten the session anyway).
   */
  const reset = useCallback(
    () =>
      serial(async () => {
        detach();
        setState(EMPTY);
        let ended = true;
        try {
          await client.reset();
        } catch {
          ended = false;
        }
        await startOver();
        return ended;
      }),
    [client, detach, serial, startOver],
  );

  /** Starts a conversation and shows it, unless the person changed in the meantime. */
  const startFor = useCallback(
    (current: number) =>
      client.startConversation().then(async (conversation) => {
        if (current === generation.current) await attach(conversation, false);
      }),
    [attach, client],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const current = generation.current;
      if (!outbox.current) {
        attaching.current ??= startFor(current);
        await attaching.current;
      }
      // Typed by the person before an identity change: never sent as the next one.
      if (current === generation.current) outbox.current?.enqueue(trimmed);
    },
    [startFor],
  );

  const retry = useCallback(
    (clientMessageId: string) => outbox.current?.retry(clientMessageId),
    [],
  );

  const handoff = useCallback(async () => {
    const current = generation.current;
    if (!state.conversation) {
      attaching.current ??= startFor(current);
      await attaching.current;
    }
    const conversation = stream.current ? state.conversation : null;
    const id = conversation?.id ?? (await client.listConversations()).items[0]?.id;
    if (!id || current !== generation.current) return;
    const outcome = await client.requestHandoff(id, crypto.randomUUID());
    if (current !== generation.current) return;
    setState((s) =>
      s.conversation
        ? {
            ...s,
            handoffNotice: outcome.message,
            conversation: { ...s.conversation, status: 'waiting_for_person', responder: 'none' },
          }
        : s,
    );
  }, [client, startFor, state.conversation]);

  /** Outgoing messages not yet visible as confirmed messages. */
  const pending = useMemo(
    () =>
      state.outgoing.filter(
        (o) => !state.messages.some((m) => m.clientMessageId === o.clientMessageId),
      ),
    [state.outgoing, state.messages],
  );

  return { state, pending, send, retry, handoff, identify, reset };
}
