import type { WidgetAppearance } from '@hamnivo/contracts';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { testChatUrl } from '../../lib/setup';
/** Renders the actual widget; the test-only bridge applies a draft without publishing it. */
export function LiveWidgetPreview({
  widgetId,
  name,
  appearance,
  locale,
}: {
  widgetId: string;
  name: string;
  appearance: WidgetAppearance;
  locale: string;
}) {
  const { t } = useTranslation();
  const frame = useRef<HTMLIFrameElement>(null);
  const url = testChatUrl(widgetId, locale);
  const origin = new URL(url).origin;
  const send = useCallback(
    () =>
      frame.current?.contentWindow?.postMessage(
        { source: 'hamnivo-studio-preview', appearance },
        origin,
      ),
    [appearance, origin],
  );
  useEffect(() => {
    send();
  }, [send]);
  useEffect(() => {
    const ready = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.origin === origin &&
        event.data?.source === 'hamnivo-widget-preview'
      )
        send();
    };
    window.addEventListener('message', ready);
    return () => window.removeEventListener('message', ready);
  }, [origin, send]);
  return (
    <iframe
      ref={frame}
      src={url}
      title={t('setup.testChat.frameTitle', { name })}
      onLoad={send}
      data-testid="live-widget-preview"
      className="h-[520px] w-full rounded-xl border border-border bg-white"
    />
  );
}
