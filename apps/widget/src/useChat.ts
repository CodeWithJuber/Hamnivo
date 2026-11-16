import {
  EventStream,
  HamnivoApiError,
  type HamnivoClient,
  Outbox,
  type OutgoingAttachment,
  type OutgoingMessage,
  type StartConversationInput,
  type StreamStatus,
} from '@hamnivo/client';
import type {
  CustomerConversation,
  FormAnswers,
  Message,
  MessagePart,
  OfflineMessageResponse,
  ReactionEmoji,
  WidgetSession,
} from '@hamnivo/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyDraftEvent, DRAFT_EVENTS, type Draft } from './drafts.js';
import { applyRunEvent, type LiveRun } from './run.js';

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
  /** The server's answer after the customer went back to the assistant (HNV-10-02). */
  assistantNotice: string | null;
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
  /** What the assistant is doing right now, from the conversation's live events; null when idle. */
  run: LiveRun | null;
  /**
   * When the visitor last sent something from this page (ms, this device's clock), until someone
   * answers. Where the gateway sends no live activity, it is how the chat knows a reply is due.
   */
  awaitingSince: number | null;
  /** When the assistant last stopped working (ms): nothing more is on its way from that run. */
  runEndedAt: number | null;
  /**
   * The gateway refused a chat write with CHAT_UNAVAILABLE (H20): chat isn't available to this
   * visitor, though help, past conversations and privacy choices are. Cleared by a session that
   * says chat is available again.
   */
  unavailable: boolean;
}

/** A deleted message keeps its place and author, nothing of what it said (W23). */
export const DELETED: MessagePart = {
  type: 'notice',
  notice: 'message_deleted',
  text: 'This message was deleted.',
};

const byTime = (a: Message, b: Message) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0);

/**
 * A history page in reading order. The server lists newest first, and the authority keeps times
 * to the second, so a question and its answer can share a time: reversing first keeps their
 * order (the sort is stable), and the answer never shows above the question.
 */
export const inOrder = (items: Message[]) => [...items].reverse().sort(byTime);

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

/** Drafts and the live run after one event, journaled or live-only. */
function withLive(s: ChatState, type: string, data: Record<string, unknown>): ChatState {
  const now = Date.now();
  const drafts = DRAFT_EVENTS.has(type) ? applyDraftEvent(s.drafts, { type, data }) : s.drafts;
  const run = applyRunEvent(s.run, { type, data }, now);
  if (drafts === s.drafts && run === s.run) return s;
  // A run that ended has nothing more on its way, whatever the visitor is still waiting for.
  const ended = s.run !== null && run === null;
  return { ...s, drafts, run, ...(ended ? { awaitingSince: null, runEndedAt: now } : {}) };
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
  assistantNotice: null,
  olderCursor: null,
  loadingOlder: false,
  latestSequence: 0,
  unread: 0,
  firstUnreadId: null,
  lastSync: null,
  drafts: [],
  run: null,
  awaitingSince: null,
  runEndedAt: null,
  unavailable: false,
};

const PAGE = 50;
const messageOf = (error: unknown) => String((error as Error)?.message ?? error);

/** The gateway's answer to a chat write from a visitor who can't chat now (H20). */
export const isChatUnavailable = (error: unknown) =>
  error instanceof HamnivoApiError && error.code === 'CHAT_UNAVAILABLE';

/** Whether chat is available to the visitor on screen: their session says so, and no write was refused. */
export const chatAvailable = (state: Pick<ChatState, 'session' | 'unavailable'>) =>
  state.session?.config.chatAvailable !== false && !state.unavailable;

/**
 * Whether the person agreed before chatting follows their session (W27): it changes when they
 * agree, and when the brand's words change. So does whether chat is available to them (H20), for
 * example once a block is lifted. The rest of the configuration stays as it started.
 */
function followConsent(state: ChatState, session: WidgetSession): ChatState {
  const shown = state.session;
  if (!shown || shown.principal.id !== session.principal.id) return state;
  const next = session.config?.consent;
  const now = shown.config.consent;
  const sameConsent =
    !next ||
    (now &&
      now.required === next.required &&
      now.given === next.given &&
      now.noticeVersion === next.noticeVersion);
  const available = session.config?.chatAvailable;
  const sameAvailability = available === undefined || available === shown.config.chatAvailable;
  if (sameConsent && sameAvailability) return state;
  return {
    ...state,
    // A session that says chat is available again outweighs an earlier refusal.
    unavailable: available === true ? false : state.unavailable,
    session: {
      ...shown,
      config: {
        ...shown.config,
        ...(next && !sameConsent ? { consent: next } : {}),
        ...(available !== undefined ? { chatAvailable: available } : {}),
      },
    },
  };
}

/** The error a suspended workspace's chat starts with: it shows offline until the workspace is back. */
export const CHAT_OFFLINE = 'workspace_suspended';
const startErrorOf = (error: unknown) =>
  (error as { problem?: { reason?: unknown } })?.problem?.reason === CHAT_OFFLINE
    ? CHAT_OFFLINE
    : messageOf(error);

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
  /**
   * Notes a refusal because chat isn't available (H20) and says whether it was one; the widget
   * then shows that chat isn't available instead of an error.
   */
  const unavailableBy = useCallback((error: unknown): boolean => {
    if (!isChatUnavailable(error)) return false;
    setState((s) => (s.unavailable ? s : { ...s, unavailable: true }));
    return true;
  }, []);
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
    setState((s) => withLive(s, event.type, data));
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
            // Someone answered: nothing is waited for until the visitor writes again.
            awaitingSince: message.sender.kind === 'customer' ? s.awaitingSince : null,
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
                awaitingSince: data.responder === 'ai' ? s.awaitingSince : null,
                conversation: {
                  ...s.conversation,
                  status: data.status as CustomerConversation['status'],
                  responder: data.responder as CustomerConversation['responder'],
                },
              }
            : s;
        case 'conversation.resolved':
          return s.conversation
            ? {
                ...s,
                awaitingSince: null,
                conversation: { ...s.conversation, status: 'resolved', responder: 'none' },
              }
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
        messages = inOrder(page.items);
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
        run: null,
        awaitingSince: null,
        runEndedAt: null,
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
          // Live-only events are for now and never replayed. A person typing goes to the parts
          // that follow it; an answer being written and what the assistant is doing are shown.
          onTransient: (event) => {
            const data = (event.data ?? {}) as Record<string, unknown>;
            for (const listener of listeners.current) listener({ type: event.type, data });
            if (event.type === 'message.delta' || event.type === 'activity') {
              setState((s) => withLive(s, event.type, data));
            }
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
                  messages: inOrder(page.items),
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
      if (!cancelled) setState((s) => ({ ...s, phase: 'error', error: startErrorOf(error) }));
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
      setState({ ...EMPTY, phase: 'error', error: startErrorOf(error) });
    }
  }, [begin, client]);

  useEffect(() => {
    // The session moved to another person without a sign-in here (for example a renewal after
    // the session was ended elsewhere): show that person, never the previous one's chats.
    const offSession = client.onSession((session) => {
      if (!session || !shown.current) return;
      if (session.principal.id === shown.current) {
        setState((s) => followConsent(s, session));
        return;
      }
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
    (current: number, input: StartConversationInput = {}) => {
      const started = client.startConversation(input).then(async (conversation) => {
        // A first message sent with the start is in the history already.
        if (current === generation.current) await attach(conversation, Boolean(input.firstMessage));
      });
      // A start that failed can be tried again: once back online, or after agreeing (W27).
      started.catch((error) => {
        if (attaching.current === started) attaching.current = null;
        unavailableBy(error);
      });
      return started;
    },
    [attach, client, unavailableBy],
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

  /**
   * Starts the first conversation with the pre-chat answers and the visitor's first message
   * (W26), when the chat asked for them before starting.
   */
  const start = useCallback(
    async (input: StartConversationInput) => {
      if (outbox.current) return;
      attaching.current ??= startFor(generation.current, input);
      await attaching.current;
    },
    [startFor],
  );

  /** The gateway asked for consent again (the brand changed its words): ask with the new ones. */
  const consentRequired = useCallback(async () => {
    setState((s) =>
      s.session?.config.consent
        ? {
            ...s,
            session: {
              ...s.session,
              config: {
                ...s.session.config,
                consent: { ...s.session.config.consent, given: false },
              },
            },
          }
        : s,
    );
    // A fresh session carries the words in force; consent follows it (see followConsent).
    await client.renew().catch(() => undefined);
  }, [client]);

  /**
   * Leaves a message while nobody can answer (W11). It becomes a ticket (H19), listed with the
   * person's conversations; the chat stays where it was.
   */
  const leaveMessage = useCallback(
    async (answers: FormAnswers, clientRequestId: string): Promise<OfflineMessageResponse> => {
      const current = generation.current;
      let sent: OfflineMessageResponse;
      try {
        sent = await client.sendOfflineMessage({ answers }, clientRequestId);
      } catch (error) {
        unavailableBy(error);
        throw error;
      }
      if (current === generation.current) {
        setState((s) => ({
          ...s,
          conversations: [
            sent.conversation,
            ...s.conversations.filter((c) => c.id !== sent.conversation.id),
          ],
        }));
      }
      return sent;
    },
    [client, unavailableBy],
  );

  const send = useCallback(
    async (text: string, attachments: readonly OutgoingAttachment[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const current = await ready();
      // Typed by the person before an identity change: never sent as the next one.
      if (current === generation.current) {
        outbox.current?.enqueue(trimmed, attachments);
        setState((s) => ({ ...s, firstUnreadId: null, awaitingSince: Date.now() }));
      }
    },
    [ready],
  );

  /** Tries to start the chat again after it could not start (the visitor asked to). */
  const retryStart = useCallback(
    () =>
      serial(async () => {
        setState(EMPTY);
        await startOver();
      }),
    [serial, startOver],
  );

  /** Puts away a problem that was shown and did not stop the chat. */
  const dismissError = useCallback(
    () => setState((s) => (s.error === null ? s : { ...s, error: null })),
    [],
  );

  /** Loads the conversation on screen again after something did not load (the visitor asked to). */
  const reconnect = useCallback(
    () =>
      serial(async () => {
        const conversation = state.conversation;
        setState((s) => (s.error === null ? s : { ...s, error: null }));
        if (!conversation) return;
        generation.current += 1;
        attaching.current = null;
        try {
          await attach(conversation, true);
        } catch (error) {
          setState((s) => ({ ...s, error: messageOf(error) }));
        }
      }),
    [attach, serial, state.conversation],
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
        messages: [...page.items].reverse().reduce(merge, s.messages),
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
    let outcome: Awaited<ReturnType<HamnivoClient['requestHandoff']>>;
    try {
      outcome = await client.requestHandoff(id, crypto.randomUUID());
    } catch (error) {
      unavailableBy(error);
      throw error;
    }
    if (current !== generation.current) return;
    setState((s) =>
      s.conversation
        ? {
            ...s,
            handoffNotice: outcome.message,
            assistantNotice: null,
            // They asked themselves, so they may change their mind while nobody has the chat.
            conversation: {
              ...s.conversation,
              status: 'waiting_for_person',
              responder: 'none',
              canReturnToAssistant: true,
            },
          }
        : s,
    );
  }, [client, startFor, state.conversation, unavailableBy]);

  /**
   * The customer no longer needs a person (HNV-10-02): the gateway says whether the assistant
   * answers again, a person already joined, or the chat stays with people, and the screen shows
   * the conversation as it now is with that message.
   */
  const cancelHandoff = useCallback(async () => {
    const current = generation.current;
    const id = state.conversation?.id;
    if (!id) return;
    let result: Awaited<ReturnType<HamnivoClient['cancelHandoff']>>;
    try {
      result = await client.cancelHandoff(id);
    } catch (error) {
      unavailableBy(error);
      throw error;
    }
    if (current !== generation.current) return;
    setState((s) =>
      s.conversation?.id === result.conversation.id
        ? {
            ...s,
            conversation: { ...s.conversation, ...result.conversation },
            handoffNotice: result.outcome === 'with_assistant' ? null : result.message,
            assistantNotice: result.outcome === 'with_assistant' ? result.message : null,
          }
        : s,
    );
  }, [client, state.conversation?.id, unavailableBy]);

  /** Opens the closed conversation on screen again, with its history (W15). */
  const reopen = useCallback(async () => {
    const conversation = state.conversation;
    if (!conversation) return;
    const current = generation.current;
    let reopened: Awaited<ReturnType<HamnivoClient['reopen']>>;
    try {
      reopened = await client.reopen(conversation.id);
    } catch (error) {
      unavailableBy(error);
      throw error;
    }
    if (current !== generation.current) return;
    setState((s) => ({
      ...s,
      conversation:
        s.conversation?.id === reopened.id ? { ...s.conversation, ...reopened } : s.conversation,
      conversations: s.conversations.map((c) => (c.id === reopened.id ? reopened : c)),
    }));
  }, [client, state.conversation, unavailableBy]);

  // A message the gateway refuses now because chat isn't available switches the chat to say so.
  // Refusals kept from an earlier visit (the outbox survives a reload) don't: the session says
  // whether chat is available now.
  const sending = useRef(new Set<string>());
  useEffect(() => {
    let refused = false;
    for (const item of state.outgoing) {
      if (item.state === 'sending') sending.current.add(item.clientMessageId);
      else if (sending.current.delete(item.clientMessageId)) {
        refused ||= item.state === 'failed' && item.errorCode === 'CHAT_UNAVAILABLE';
      }
    }
    if (refused) setState((s) => (s.unavailable ? s : { ...s, unavailable: true }));
  }, [state.outgoing]);

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
    cancelHandoff,
    identify,
    reset,
    onEvent,
    loadOlder,
    markSeen,
    deleteMessage,
    react,
    open,
    conversationForFiles,
    start,
    consentRequired,
    leaveMessage,
    reopen,
    unavailableBy,
    retryStart,
    dismissError,
    reconnect,
  };
}
