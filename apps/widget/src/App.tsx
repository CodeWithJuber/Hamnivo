import { HamnivoClient } from '@hamnivo/client';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostBridge } from './bridge.js';
import { Chat } from './components/Chat.js';
import { applyLocale, type Locale } from './i18n.js';
import { useChat } from './useChat.js';
import { useMemory } from './useMemory.js';
import { useReplyLanguage } from './useReplyLanguage.js';

export interface WidgetParams {
  apiBase: string;
  widgetId: string;
  hostOrigin: string | null;
  locale: Locale;
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
        ...(params.hostOrigin ? { hostOrigin: params.hostOrigin } : {}),
      }),
    [params],
  );
  const chat = useChat(client);
  const replies = chat.state.messages.filter((m) => m.sender.kind !== 'customer').length;
  const language = useReplyLanguage(client, chat.state.session?.principal.id ?? null, replies);
  const { saveLocale } = language;
  const memory = useMemory(client, chat.state.session?.principal.id ?? null);

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
  useEffect(() => {
    bridge.post({ type: 'ready', widgetVersion: '0.1.0' });
    const identityChanged = (verified: boolean) =>
      bridge.post({ type: 'event', event: 'identity.changed', payload: { verified } });
    return bridge.listen((message) => {
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
  }, [bridge, identify, reset]);

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
        {t('startError')}
      </p>
    );
  }
  return (
    <AnnouncerProvider>
      <Chat
        session={chat.state.session}
        state={chat.state}
        pending={chat.pending}
        locale={locale}
        onLocale={(next) => {
          setLocale(next);
          void saveLocale(next);
        }}
        onSend={chat.send}
        onRetry={(id) => chat.retry(id)}
        onHandoff={chat.handoff}
        language={language}
        memory={memory}
        onClose={
          params.hostOrigin
            ? () => bridge.post({ type: 'layout', open: false, width: 0, height: 0 })
            : undefined
        }
      />
    </AnnouncerProvider>
  );
}
