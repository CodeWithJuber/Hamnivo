import { defaultStorage, HamnivoClient, prefixedStorage } from '@hamnivo/client';
import type { WidgetAppearance, WidgetLayoutMode } from '@hamnivo/contracts';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionsContext, useActions } from './actions/useActions.js';
import type { HostBridge } from './bridge.js';
import { useCommerce } from './commerce/useCommerce.js';
import { Chat } from './components/Chat.js';
import { ChatSkeleton, StartError } from './components/shell/Skeleton.js';
import { type ChatSnapshot, eventsBetween, snapshotOf } from './hostEvents.js';
import { applyLocale, type Locale } from './i18n.js';
import { previewConfig, previewTextColour, readPreview } from './preview.js';
import { applyTheme, resolveScheme, type Scheme } from './theme.js';
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
  /** Light or dark, as the website around the chat is; null when it did not say. */
  theme?: Scheme | null;
  /** What the loader around the chat can do for it (`caps` in the address): `env`, `resize`. */
  caps?: readonly string[];
}

const darkDevice = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** The visitor's device setting, which the chat follows only where it is a page of its own. */
function useDeviceScheme(): Scheme {
  const [dark, setDark] = useState(darkDevice);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return dark ? 'dark' : 'light';
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
  const [preview, setPreview] = useState<WidgetAppearance | null>(null);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const next = readPreview(event, window.parent, params.hostOrigin, params.test === true);
      if (next) setPreview(next);
    };
    if (!params.test) return;
    window.addEventListener('message', receive);
    window.parent.postMessage(
      { source: 'hamnivo-widget-preview', ready: true },
      params.hostOrigin ?? window.location.origin,
    );
    return () => window.removeEventListener('message', receive);
  }, [params.test, params.hostOrigin]);
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
  const accent = preview?.primaryColor ?? chat.state.session?.config.brand.accent;
  const onAccent = preview
    ? previewTextColour(preview.primaryColor)
    : chat.state.session?.config.brand.onAccent;
  const radius = preview?.radius ?? chat.state.session?.config.brand.radius;
  const fontFamily = preview?.fontFamily ?? chat.state.session?.config.brand.fontFamily;
  // Light or dark is said on the page itself, so the chat never turns dark on a light website
  // only because the visitor's device is dark.
  const device = useDeviceScheme();
  /** What the loader says about the page around the chat; it changes with the page. */
  const [around, setAround] = useState<{
    theme: Scheme | null;
    fullScreen: boolean;
    expanded: boolean;
  }>({ theme: params.theme ?? null, fullScreen: false, expanded: false });
  // A draft in Studio wins; on a website the loader already chose (its attribute, then the
  // brand's choice, then the page) and says so; on the chat's own page the brand's choice counts.
  const brandTheme =
    preview?.theme ?? (around.theme ? 'auto' : chat.state.session?.config.brand.theme);
  const scheme = resolveScheme(brandTheme, around.theme, Boolean(params.hostOrigin), device);
  useEffect(() => {
    document.documentElement.dataset.theme = scheme;
  }, [scheme]);
  useEffect(() => {
    if (accent !== undefined && onAccent !== undefined && radius !== undefined) {
      applyTheme(document.documentElement, { accent, onAccent, radius, fontFamily }, scheme);
    }
  }, [accent, onAccent, radius, fontFamily, scheme]);
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

  // The launcher shows how many replies wait while the chat is closed (W05), and over the closed
  // chat who sent the newest one, never what they wrote. The visitor chooses whether it sounds.
  const { unread } = chat.state;
  const replyFrom =
    chat.state.messages.findLast((m) => m.sender.kind !== 'customer' && m.sender.kind !== 'system')
      ?.sender.displayName ?? '';
  const sound = display.prefs.sound;
  useEffect(() => {
    const label =
      unread > 0 && replyFrom ? t('surface.alerts.newReply', { name: replyFrom }) : null;
    bridge.post({ type: 'event', event: 'unread', payload: { count: unread, label, sound } });
  }, [bridge, unread, replyFrom, sound, t]);

  // What happened in the chat, for the website's Hamnivo.on(...) listeners (see hostEvents.ts).
  const { conversation, messages, phase, error, conversations } = chat.state;
  const sessionConversations = chat.state.session?.conversations;
  const seen = useRef<{ snapshot: ChatSnapshot; known: Set<string> } | null>(null);
  useEffect(() => {
    const now = snapshotOf({ conversation, messages, phase, error });
    const before = seen.current;
    const known = new Set([...conversations, ...(sessionConversations ?? [])].map((c) => c.id));
    seen.current = { snapshot: now, known };
    // The first look is where the chat starts from, not something that happened.
    if (!before) return;
    for (const { event, payload } of eventsBetween(before.snapshot, now, before.known)) {
      bridge.post({ type: 'event', event, payload });
    }
  }, [bridge, conversation, messages, phase, error, conversations, sessionConversations]);

  /** Words the website typed into the message box (Hamnivo.prefill); the visitor sends them. */
  const [prefill, setPrefill] = useState<{ text: string; at: number } | null>(null);

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
      if (message.type === 'prefill') setPrefill({ text: message.text, at: Date.now() });
      if (message.type === 'visitor') setVisitorKey(message.key);
      if (message.type === 'env') {
        setAround((now) => ({
          theme: message.theme ?? now.theme,
          fullScreen: message.fullScreen ?? now.fullScreen,
          expanded: message.expanded ?? now.expanded,
        }));
        // The screen's own bottom edge, which a frame cannot measure for itself.
        if (message.safeBottom !== undefined) {
          document.documentElement.style.setProperty('--hv-safe-bottom', `${message.safeBottom}px`);
        }
      }
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

  if (chat.state.phase === 'loading') return <ChatSkeleton label={t('ui.loading')} />;
  if (chat.state.phase === 'error' || !chat.state.session) {
    return (
      <StartError
        message={chat.state.error === CHAT_OFFLINE ? t('chatOffline') : t('startError')}
        retry={t('ui.retry')}
        onRetry={() => void chat.retryStart()}
      />
    );
  }
  const session = preview
    ? { ...chat.state.session, config: previewConfig(chat.state.session.config, preview) }
    : chat.state.session;
  const mode = params.mode ?? session.config.layout?.mode ?? 'bubble';
  // Only the brand's own words, from its configuration (the page sends nothing but the id), or a
  // message the team left for this visitor, which comes from the gateway, not from the page.
  const prompt =
    session.config.proactive?.triggers.find((t) => t.id === trigger)?.message[locale] ??
    visitor.state.invite?.message ??
    null;
  // Inline and full-page chats have no launcher to go back to.
  const closable = Boolean(params.hostOrigin) && mode !== 'inline' && mode !== 'fullpage';
  // A floating or side-panel chat can grow where the loader can resize it and there is room.
  const resizable = closable && params.caps?.includes('resize') === true && !around.fullScreen;
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
          prefill={prefill}
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
          onCancelHandoff={chat.cancelHandoff}
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
          expand={
            resizable
              ? {
                  expanded: around.expanded,
                  onToggle: () =>
                    bridge.post({ type: 'resize', size: around.expanded ? 'default' : 'expanded' }),
                }
              : null
          }
          onDismissError={chat.dismissError}
          onStop={() => void chat.stop()}
          onReconnect={() => void chat.reconnect()}
          headerStyle={session.config.brand.headerStyle}
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
