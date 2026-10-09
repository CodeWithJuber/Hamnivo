import { defaultStorage, HamnivoClient, prefixedStorage } from '@hamnivo/client';
import type { WidgetLayoutMode } from '@hamnivo/contracts';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionsContext, useActions } from './actions/useActions.js';
import type { HostBridge } from './bridge.js';
import { useCommerce } from './commerce/useCommerce.js';
import { Chat } from './components/Chat.js';
import { applyLocale, type Locale } from './i18n.js';
import { applyTheme } from './theme.js';
import { CHAT_OFFLINE, useChat } from './useChat.js';
import { useDisplay } from './useDisplay.js';
import { useMemory } from './useMemory.js';
import { useReplyLanguage } from './useReplyLanguage.js';
import { useStaffTyping } from './useTyping.js';
import { useVisitor } from './useVisitor.js';

export interface WidgetParams {
  apiBase: string;
  widgetId: string;
  hostOrigin: string | null;
  locale: Locale;
  /** How the loader placed the chat on the page (W02); null when the brand's choice applies. */
  mode: WidgetLayoutMode | null;
  /** Studio's test chat: its own session, and the conversations it starts are marked as tests. */
  test?: boolean;
  /** The brand's direct chat link (W28): the chat on its own page, with no website around it. */
  direct?: boolean;
}

export function App({ params, bridge }: { params: WidgetParams; bridge: HostBridge }) {
  const { t, i18n } = useTranslation();
  const [locale, setLocale] = useState<Locale>(params.locale);
  const client = useMemo(
    () =>
      new HamnivoClient({
        apiBase: params.apiBase,
        widgetId: params.widgetId,
        locale: params.locale,
        ...(params.direct
          ? { direct: true }
          : params.hostOrigin
            ? { hostOrigin: params.hostOrigin }
            : {}),
        // A test chat keeps its own session, never a real visitor's.
        ...(params.test ? { test: true, storage: prefixedStorage(defaultStorage(), 'test:') } : {}),
      }),
    [params],
  );
  const chat = useChat(client);
  // On its own page the chat is the page: the tab says whose chat it is.
  const brandName = chat.state.session?.config.brand.name;
  useEffect(() => {
    if (params.direct && brandName) document.title = brandName;
  }, [params.direct, brandName]);
  const replies = chat.state.messages.filter((m) => m.sender.kind !== 'customer').length;
  const language = useReplyLanguage(client, chat.state.session?.principal.id ?? null, replies);
  const { saveLocale } = language;
  const commerce = useCommerce(client, chat.state.conversation?.id ?? null);
  const { onEvent } = chat;
  useEffect(() => onEvent(commerce.onEvent), [onEvent, commerce.onEvent]);
  const memory = useMemory(client, chat.state.session?.principal.id ?? null);
  const actions = useActions(client, chat.state.conversation?.id ?? null, bridge);
  useEffect(() => onEvent(actions.onEvent), [onEvent, actions.onEvent]);
  const staffTyping = useStaffTyping(onEvent);
  const visitor = useVisitor(client, chat.state.session?.principal.id ?? null, locale);
  const display = useDisplay(params.widgetId);
  // The brand's colour and corners (W03); Hamnivo's own look stays as it is.
  const accent = chat.state.session?.config.brand.accent;
  const onAccent = chat.state.session?.config.brand.onAccent;
  const radius = chat.state.session?.config.brand.radius;
  useEffect(() => {
    if (accent !== undefined && onAccent !== undefined && radius !== undefined) {
      applyTheme(document.documentElement, { accent, onAccent, radius });
    }
  }, [accent, onAccent, radius]);
  // Embedded, the chat is on screen only while the loader shows it; on its own page, always.
  const [open, setOpen] = useState(
    !params.hostOrigin || params.mode === 'inline' || params.mode === 'fullpage',
  );
  const [pageShown, setPageShown] = useState(document.visibilityState === 'visible');
  /** The proactive prompt the visitor opened the chat from (W19), by trigger id. */
  const [trigger, setTrigger] = useState<string | null>(null);

  useEffect(() => {
    const onVisibility = () => setPageShown(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // The launcher shows how many replies wait while the chat is closed (W05).
  const { unread } = chat.state;
  useEffect(() => {
    bridge.post({ type: 'event', event: 'unread', payload: { count: unread } });
  }, [bridge, unread]);

  useEffect(() => {
    applyLocale(locale);
    void i18n.changeLanguage(locale);
  }, [i18n, locale]);

  // Escape closes the chat and returns focus to the launcher (focus is inside this frame).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        bridge.post({ type: 'layout', open: false, width: 0, height: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bridge]);

  const { identify, reset } = chat;
  const { setKey: setVisitorKey } = visitor;
  useEffect(() => {
    bridge.post({ type: 'ready', widgetVersion: '0.1.0' });
    const identityChanged = (verified: boolean) =>
      bridge.post({ type: 'event', event: 'identity.changed', payload: { verified } });
    return bridge.listen((message) => {
      if (message.type === 'open') setOpen(true);
      if (message.type === 'close') setOpen(false);
      if (message.type === 'proactive') setTrigger(message.triggerId);
      if (message.type === 'visitor') setVisitorKey(message.key);
      if (message.type === 'set-locale')
        setLocale((message.locale.split('-')[0] as Locale) ?? 'en');
      if (message.type === 'identify') {
        void identify(message.assertion)
          .then(() => {
            identityChanged(true);
            bridge.post({ type: 'result', requestId: message.requestId, ok: true });
          })
          .catch(() =>
            bridge.post({
              type: 'result',
              requestId: message.requestId,
              ok: false,
              error: 'identity_rejected',
            }),
          );
      }
      if (message.type === 'reset') {
        // The website signed the customer out: nothing of theirs stays on screen or on the device.
        void reset().then((ended) => {
          identityChanged(false);
          bridge.post(
            ended
              ? { type: 'result', requestId: message.requestId, ok: true }
              : {
                  type: 'result',
                  requestId: message.requestId,
                  ok: false,
                  error: 'reset_incomplete',
                },
          );
        });
      }
    });
  }, [bridge, identify, reset, setVisitorKey]);

  if (chat.state.phase === 'loading') {
    return (
      <p className="p-6 text-sm text-text-muted" role="status">
        …
      </p>
    );
  }
  if (chat.state.phase === 'error' || !chat.state.session) {
    return (
      <p className="p-6 text-sm text-text" role="alert">
        {chat.state.error === CHAT_OFFLINE ? t('chatOffline') : t('startError')}
      </p>
    );
  }
  const session = chat.state.session;
  const mode = params.mode ?? session.config.layout?.mode ?? 'bubble';
  // Only the brand's own words, from its configuration (the page sends nothing but the id), or a
  // message the team left for this visitor, which comes from the gateway, not from the page.
  const prompt =
    session.config.proactive?.triggers.find((t) => t.id === trigger)?.message[locale] ??
    visitor.state.invite?.message ??
    null;
  // Inline and full-page chats have no launcher to go back to.
  const closable = Boolean(params.hostOrigin) && mode !== 'inline' && mode !== 'fullpage';
  return (
    <AnnouncerProvider>
      <ActionsContext.Provider value={actions}>
        <Chat
          client={client}
          session={session}
          state={chat.state}
          commerce={commerce}
          pending={chat.pending}
          locale={locale}
          mode={mode}
          visible={open && pageShown}
          display={display}
          prompt={prompt}
          staffTyping={staffTyping}
          visitorNotice={visitor.state.notice}
          onLocale={(next) => {
            setLocale(next);
            void saveLocale(next);
          }}
          onSend={chat.send}
          onRetry={(id) => chat.retry(id)}
          onRemove={chat.remove}
          onFlush={chat.flush}
          onHandoff={chat.handoff}
          onLoadOlder={chat.loadOlder}
          onSeen={chat.markSeen}
          onDelete={chat.deleteMessage}
          onReact={chat.react}
          onOpenConversation={chat.open}
          onFilesConversation={chat.conversationForFiles}
          onStart={chat.start}
          onReopen={chat.reopen}
          onLeaveMessage={chat.leaveMessage}
          onConsentRequired={chat.consentRequired}
          onUnavailable={chat.unavailableBy}
          language={language}
          memory={memory}
          onClose={
            closable
              ? () => bridge.post({ type: 'layout', open: false, width: 0, height: 0 })
              : undefined
          }
        />
      </ActionsContext.Provider>
    </AnnouncerProvider>
  );
}
