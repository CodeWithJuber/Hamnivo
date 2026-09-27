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
}

const byTime = (a: Message, b: Message) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.sequence ?? 0) - (b.sequence ?? 0);

function merge(messages: Message[], incoming: Message): Message[] {
  const without = messages.filter((m) => m.id !== incoming.id);
  return [...without, incoming].sort(byTime);
}

/**
 * The visitor's side of one conversation: session, history, live stream and the send outbox.
 * Confirmed messages come only from the server (history or stream); unsent ones from the outbox.
 */
export function useChat(client: HamnivoClient) {
  const [state, setState] = useState<ChatState>({
    phase: 'loading',
    session: null,
    conversation: null,
    messages: [],
    outgoing: [],
    connection: 'idle',
    error: null,
  });
  const stream = useRef<EventStream | null>(null);
  const outbox = useRef<Outbox | null>(null);
  const attaching = useRef<Promise<void> | null>(null);

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
      stream.current?.close();
      outbox.current?.dispose();
      let after = conversation.latestSequence;
      let messages: Message[] = [];
      if (loadHistory) {
        const page = await client.history(conversation.id, { limit: 50 });
        messages = [...page.items].sort(byTime);
        after = page.latestSequence;
      }
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
            void client
              .history(conversation.id, { limit: 50 })
              .then((page) => setState((s) => ({ ...s, messages: [...page.items].sort(byTime) })));
          },
          onError: (error) =>
            setState((s) => ({ ...s, error: String((error as Error).message ?? error) })),
        },
        { after },
      );
    },
    [apply, client],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await client.connect();
        if (cancelled) return;
        const conversation =
          session.conversations.find((c) => c.status !== 'resolved') ??
          session.conversations[0] ??
          null;
        setState((s) => ({ ...s, phase: 'ready', session }));
        if (conversation) await attach(conversation, true);
      } catch (error) {
        if (!cancelled)
          setState((s) => ({
            ...s,
            phase: 'error',
            error: String((error as Error).message ?? error),
          }));
      }
    })();
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
      stream.current?.close();
      outbox.current?.dispose();
    };
  }, [attach, client]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!outbox.current) {
        attaching.current ??= client.startConversation().then((c) => attach(c, false));
        await attaching.current;
      }
      outbox.current?.enqueue(trimmed);
    },
    [attach, client],
  );

  const retry = useCallback(
    (clientMessageId: string) => outbox.current?.retry(clientMessageId),
    [],
  );

  const handoff = useCallback(async () => {
    if (!state.conversation) {
      attaching.current ??= client.startConversation().then((c) => attach(c, false));
      await attaching.current;
    }
    const conversation = stream.current ? state.conversation : null;
    const id = conversation?.id ?? (await client.listConversations()).items[0]?.id;
    if (!id) return;
    await client.requestHandoff(id, crypto.randomUUID());
    setState((s) =>
      s.conversation
        ? {
            ...s,
            conversation: { ...s.conversation, status: 'waiting_for_person', responder: 'none' },
          }
        : s,
    );
  }, [attach, client, state.conversation]);

  /** Outgoing messages not yet visible as confirmed messages. */
  const pending = useMemo(
    () =>
      state.outgoing.filter(
        (o) => !state.messages.some((m) => m.clientMessageId === o.clientMessageId),
      ),
    [state.outgoing, state.messages],
  );

  return { state, pending, send, retry, handoff };
}
