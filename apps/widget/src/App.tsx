import { HamnivoClient } from '@hamnivo/client';
import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostBridge } from './bridge.js';
import { Chat } from './components/Chat.js';
import { applyLocale, type Locale } from './i18n.js';
import { useChat } from './useChat.js';

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

  useEffect(() => {
    bridge.post({ type: 'ready', widgetVersion: '0.1.0' });
    return bridge.listen((message) => {
      if (message.type === 'set-locale')
        setLocale((message.locale.split('-')[0] as Locale) ?? 'en');
      if (message.type === 'identify') {
        void client
          .identify(message.assertion)
          .then(() => bridge.post({ type: 'result', requestId: message.requestId, ok: true }))
          .catch(() =>
            bridge.post({
              type: 'result',
              requestId: message.requestId,
              ok: false,
              error: 'identity_rejected',
            }),
          );
      }
    });
  }, [bridge, client]);

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
        onLocale={setLocale}
        onSend={chat.send}
        onRetry={(id) => chat.retry(id)}
        onHandoff={chat.handoff}
        onClose={
          params.hostOrigin
            ? () => bridge.post({ type: 'layout', open: false, width: 0, height: 0 })
            : undefined
        }
      />
    </AnnouncerProvider>
  );
}
