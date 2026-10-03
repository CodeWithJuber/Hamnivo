import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Cloudflare Turnstile, the human check on sign-up when the server has keys for it. The script
 * loads from Cloudflare only on pages that show the check; the token it gives goes to the gateway
 * in the x-captcha-response header and works once.
 */

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      language?: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile not loaded'));
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Turnstile not loaded'));
    };
    document.head.append(script);
  });
  return loading;
}

export function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    loadTurnstile().then(
      (turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          language: i18n.language,
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
      if (widgetId) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, i18n.language, onToken]);
  return (
    <div className="flex flex-col gap-2" data-testid="turnstile">
      <p className="text-sm font-medium text-text">{t('billing.signup.captcha')}</p>
      <div ref={container} className="min-h-[65px]" />
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {t('billing.signup.captchaUnavailable')}
        </p>
      ) : null}
    </div>
  );
}
