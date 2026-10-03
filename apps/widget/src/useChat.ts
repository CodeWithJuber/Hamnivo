import {
  EventStream,
  type HamnivoClient,
  Outbox,
  type OutgoingAttachment,
  type OutgoingMessage,
  type StreamStatus,
} from '@hamnivo/client';
import type {
  CustomerConversation,
  Message,
  MessagePart,
  ReactionEmoji,
  WidgetSession,
} from '@hamnivo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyDraftEvent, DRAFT_EVENTS, type Draft } from './drafts.js';

export type Connection = StreamStatus | 'idle' | 'offline';

/** A live event of the conversation, as other parts of the widget see it. */
export interface ChatEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface ChatState {
  phase: 'loading' | 'ready' | 'error';
  session: WidgetSession | null;
  conversation: CustomerConversation | null;
  /** The person's conversations, newest first (on every device once they are signed in, W18). */
  conversations: CustomerConversation[];
  messages: Message[];
  outgoing: readonly OutgoingMessage[];
  connection: Connection;
  error: string | null;
  /** The server's answer to "talk to a person", such as when people are back (W11). */
  handoffNotice: string | null;
  /** Where older history continues (W05); null when everything is shown. */
  olderCursor: string | null;
  loadingOlder: boolean;
  /** The newest journal position shown, which is what "read" refers to. */
  latestSequence: number;
  /** Replies the person has not seen yet (W05). */
  unread: number;
  /** The first reply that was unread when the conversation opened (the "new messages" line). */
  firstUnreadId: string | null;
  /** When the chat last heard from the server, for the offline banner. */
  lastSync: string | null;
  /** AI replies still being written or checked: provisional, never shown as messages. */
  drafts: readonly Draft[];
}

/** A deleted message keeps its place and author, nothing of what it said (W23). */
export const DELETED: MessagePart = {
  type: 'notice',
  notice: 'message_deleted',
  text: 'This message was deleted.',
};

const byTime = (a: Message, b: Message) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0);

function merge(messages: Message[], incoming: Message): Message[] {
  const previous = messages.find((m) => m.id === incoming.id);
  const without = messages.filter((m) => m.id !== incoming.id);
  // A read receipt that arrived first is not lost when the message itself comes again.
  const delivery = previous?.delivery === 'read' ? 'read' : incoming.delivery;
  return [...without, { ...incoming, delivery }].sort(byTime);
}

/** Marks a message and every earlier one from the customer as read (W06). */
function markRead(messages: Message[], messageId: string): Message[] {
  const target = messages.find((m) => m.id === messageId);
  if (!target) return messages;
  const until = Date.parse(target.createdAt);
  return messages.map((m) =>
    m.sender.kind === 'customer' && Date.parse(m.createdAt) <= until && m.delivery !== 'read'
      ? { ...m, delivery: 'read' }
      : m,
  );
}

/** The first of the last `unread` replies, where the "new messages" line goes. */
function firstUnread(messages: Message[], unread: number): string | null {
  if (unread <= 0) return null;
  let left = unread;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Message;
    if (message.sender.kind === 'customer') continue;
    left -= 1;
    if (left === 0) return message.id;
  }
  return messages.find((m) => m.sender.kind !== 'customer')?.id ?? null;
}

const EMPTY: ChatState = {
  phase: 'loading',
  session: null,
  conversation: null,
  conversations: [],
  messages: [],
  outgoing: [],
  connection: 'idle',
  error: null,
  handoffNotice: null,
  olderCursor: null,
  loadingOlder: false,
  latestSequence: 0,
  unread: 0,
  firstUnreadId: null,
  lastSync: null,
  drafts: [],
};

const PAGE = 50;
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
  /** The journal position last reported as read, so it is reported once. */
  const reported = useRef(0);
  /** Other parts of the widget (the shop) that follow live events. */
  const listeners = useRef(new Set<(event: ChatEvent) => void>());
  const onEvent = useCallback((listener: (event: ChatEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

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
    const sequence = Number(event.sequence);
    for (const listener of listeners.current) listener({ type: event.type, data });
    if (DRAFT_EVENTS.has(event.type)) {
      setState((s) => {
        const drafts = applyDraftEvent(s.drafts, { type: event.type, data });
        return drafts === s.drafts ? s : { ...s, drafts };
      });
    }
    setState((current) => {
      const s: ChatState = {
        ...current,
        lastSync: new Date().toISOString(),
        latestSequence: Number.isFinite(sequence)
          ? Math.max(current.latestSequence, sequence)
          : current.latestSequence,
      };
      switch (event.type) {
        case 'message.created':
        case 'message.updated': {
          const message = data.message as Message;
          if (message.clientMessageId) outbox.current?.settle(message.clientMessageId);
          const isNew =
            event.type === 'message.created' &&
            message.sender.kind !== 'customer' &&
            !s.messages.some((m) => m.id === message.id);
          return {
            ...s,
            messages: merge(s.messages, message),
            unread: isNew ? s.unread + 1 : s.unread,
          };
        }
        case 'message.redacted':
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === data.messageId ? { ...m, parts: [DELETED] } : m,
            ),
          };
        case 'delivery.updated':
          return data.state === 'read'
            ? { ...s, messages: markRead(s.messages, String(data.messageId)) }
            : s;
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
      let olderCursor: string | null = null;
      if (loadHistory) {
        const page = await client.history(conversation.id, { limit: PAGE });
        if (stale()) return;
        messages = [...page.items].sort(byTime);
        after = page.latestSequence;
        olderCursor = page.olderCursor;
      }
      if (stale()) return;
      reported.current = 0;
      setState((s) => ({
        ...s,
        conversation,
        conversations: s.conversations.some((c) => c.id === conversation.id)
          ? s.conversations
          : [conversation, ...s.conversations],
        messages,
        drafts: [],
        olderCursor,
        loadingOlder: false,
        latestSequence: after,
        unread: conversation.unreadCount,
        firstUnreadId: firstUnread(messages, conversation.unreadCount),
        lastSync: new Date().toISOString(),
      }));
      const box = new Outbox(client, conversation.id);
      outbox.current = box;
      box.subscribe((items) => setState((s) => ({ ...s, outgoing: items })));
      stream.current = new EventStream(
        client,
        conversation.id,
        {
          onEvent: apply,
          // Live-only events (a person typing) go to the parts that follow them, nowhere else.
          onTransient: (event) => {
            const data = (event.data ?? {}) as Record<string, unknown>;
            for (const listener of listeners.current) listener({ type: event.type, data });
          },
          onStatus: (connection) =>
            setState((s) => ({
              ...s,
              connection:
                s.connection === 'offline' && connection !== 'open' ? 'offline' : connection,
              ...(connection === 'open' ? { lastSync: new Date().toISOString() } : {}),
            })),
          onResync: () => {
            void client.history(conversation.id, { limit: PAGE }).then((page) => {
              if (!stale())
                setState((s) => ({
                  ...s,
                  messages: [...page.items].sort(byTime),
                  olderCursor: page.olderCursor,
                  latestSequence: page.latestSequence,
                }));
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
      setState({
        ...EMPTY,
        phase: 'ready',
        session,
        conversations: session.conversations,
        connection:
          typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'idle',
      });
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

  /** The conversation to send in, started first when there is none yet. */
  const ready = useCallback(async (): Promise<number> => {
    const current = generation.current;
    if (!outbox.current) {
      attaching.current ??= startFor(current);
      await attaching.current;
    }
    return current;
  }, [startFor]);

  const send = useCallback(
    async (text: string, attachments: readonly OutgoingAttachment[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const current = await ready();
      // Typed by the person before an identity change: never sent as the next one.
      if (current === generation.current) {
        outbox.current?.enqueue(trimmed, attachments);
        setState((s) => ({ ...s, firstUnreadId: null }));
      }
    },
    [ready],
  );

  /** The conversation files are uploaded to; started on the first file if needed. */
  const conversationForFiles = useCallback(async (): Promise<string | null> => {
    const current = await ready();
    if (current !== generation.current) return null;
    return outbox.current?.conversationId ?? null;
  }, [ready]);

  const retry = useCallback(
    (clientMessageId: string) => outbox.current?.retry(clientMessageId),
    [],
  );

  /** Takes back an unsent message, to edit or drop it. */
  const remove = useCallback(
    (clientMessageId: string) => outbox.current?.remove(clientMessageId) ?? null,
    [],
  );

  /** "Try again" while offline or reconnecting: send what waits. */
  const flush = useCallback(() => outbox.current?.flush(), []);

  /** Older messages above the ones shown (W05). */
  const loadOlder = useCallback(async () => {
    const conversation = state.conversation;
    const before = state.olderCursor;
    if (!conversation || !before || state.loadingOlder) return;
    const current = generation.current;
    setState((s) => ({ ...s, loadingOlder: true }));
    try {
      const page = await client.history(conversation.id, { before, limit: PAGE });
      if (current !== generation.current) return;
      setState((s) => ({
        ...s,
        loadingOlder: false,
        olderCursor: page.olderCursor,
        messages: page.items.reduce(merge, s.messages),
      }));
    } catch (error) {
      if (current === generation.current)
        setState((s) => ({ ...s, loadingOlder: false, error: messageOf(error) }));
    }
  }, [client, state.conversation, state.olderCursor, state.loadingOlder]);

  /** The person saw everything up to now (W05, W06): unread counts drop, staff see it read. */
  const markSeen = useCallback(() => {
    const conversation = state.conversation;
    if (!conversation) return;
    const upTo = state.latestSequence;
    if (state.unread > 0) setState((s) => ({ ...s, unread: 0 }));
    if (upTo <= reported.current) return;
    reported.current = upTo;
    void client.markRead(conversation.id, upTo).catch(() => {
      reported.current = 0;
    });
  }, [client, state.conversation, state.latestSequence, state.unread]);

  /** Deletes one of the person's own messages (W23); the reason is thrown when it can't be. */
  const deleteMessage = useCallback(
    async (messageId: string) => {
      const conversation = state.conversation;
      if (!conversation) return;
      await client.deleteMessage(conversation.id, messageId);
      setState((s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === messageId ? { ...m, parts: [DELETED] } : m)),
      }));
    },
    [client, state.conversation],
  );

  /** Reacts to a reply (W22). */
  const react = useCallback(
    async (messageId: string, emoji: ReactionEmoji) => {
      const conversation = state.conversation;
      if (!conversation) return;
      const result = await client.react(conversation.id, messageId, crypto.randomUUID(), emoji);
      setState((s) => ({ ...s, messages: merge(s.messages, result.message) }));
    },
    [client, state.conversation],
  );

  /** Shows another of the person's conversations (W18). */
  const open = useCallback(
    (conversationId: string) =>
      serial(async () => {
        const conversation = state.conversations.find((c) => c.id === conversationId);
        if (!conversation || conversation.id === state.conversation?.id) return;
        generation.current += 1;
        attaching.current = null;
        await attach(conversation, true);
      }),
    [attach, serial, state.conversation?.id, state.conversations],
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

  return {
    state,
    pending,
    send,
    retry,
    remove,
    flush,
    handoff,
    identify,
    reset,
    onEvent,
    loadOlder,
    markSeen,
    deleteMessage,
    react,
    open,
    conversationForFiles,
  };
}
