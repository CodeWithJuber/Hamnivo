import { AUTH_BASE } from './config';

/**
 * Single sign-on from Studio (A13, board 02). The gateway finds the identity provider for the
 * address's domain and returns where to send the browser; the provider sends it back to the
 * gateway, which signs the person in and continues to `callbackPath`.
 */

const METHOD_KEY = 'hamnivo.studio.signInMethod';
export const SSO_DONE_MESSAGE = 'hamnivo:sso-done';

export type SignInMethod = 'password' | 'passkey' | 'sso';

/** How this browser last signed in, so signing in again can offer the same way first. */
export function lastSignInMethod(): SignInMethod | null {
  try {
    const value = window.localStorage.getItem(METHOD_KEY);
    return value === 'password' || value === 'passkey' || value === 'sso' ? value : null;
  } catch {
    return null;
  }
}

export function rememberSignInMethod(method: SignInMethod): void {
  try {
    window.localStorage.setItem(METHOD_KEY, method);
  } catch {
    // Not remembered: the dialog then offers every way.
  }
}

export type SsoStart =
  | { url: string }
  | { error: 'not_set_up' | 'network' | 'rate_limited' | 'failed' };

/** Asks the gateway where single sign-on for this address starts. */
export async function startSso(
  email: string,
  callbackPath: string,
  errorPath: string,
): Promise<SsoStart> {
  const origin = window.location.origin;
  let response: Response;
  try {
    response = await fetch(`${AUTH_BASE}/sign-in/sso`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: email.trim(),
        callbackURL: `${origin}${callbackPath}`,
        errorCallbackURL: `${origin}${errorPath}`,
      }),
    });
  } catch {
    return { error: 'network' };
  }
  if (response.status === 404) return { error: 'not_set_up' };
  if (response.status === 429) return { error: 'rate_limited' };
  if (!response.ok) return { error: 'failed' };
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  return typeof body?.url === 'string' ? { url: body.url } : { error: 'failed' };
}

export type SsoPopupResult = { ok: true } | { ok: false; error: string };

/**
 * Signs in again through single sign-on in a small window, so the page underneath (and any
 * unsaved work) stays as it is. Must be called straight from a click, or the browser blocks it.
 */
export async function ssoInPopup(email: string): Promise<SsoPopupResult> {
  const popup = window.open('', 'hamnivo-sso', 'popup,width=520,height=700');
  if (!popup) return { ok: false, error: 'popup_blocked' };
  const started = await startSso(email, '/sso/done', '/sso/done');
  if ('error' in started) {
    popup.close();
    return { ok: false, error: started.error };
  }
  popup.location.href = started.url;
  return new Promise((resolve) => {
    const finish = (result: SsoPopupResult) => {
      window.removeEventListener('message', onMessage);
      clearInterval(watcher);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data as { type?: unknown; error?: unknown } | null;
      if (data?.type !== SSO_DONE_MESSAGE) return;
      finish(typeof data.error === 'string' ? { ok: false, error: data.error } : { ok: true });
    };
    const watcher = setInterval(() => {
      if (popup.closed) finish({ ok: false, error: 'closed' });
    }, 500);
    window.addEventListener('message', onMessage);
  });
}

/** Codes the gateway sends back after a failed single sign-on, with their message keys. */
export const SSO_ERRORS = [
  'sso_email_unverified',
  'sso_domain_mismatch',
  'sso_unverified_local_account',
  'sso_unavailable',
  'access_denied',
] as const;

export type SsoErrorKey = (typeof SSO_ERRORS)[number] | 'generic';

export function ssoErrorKey(code: string | undefined): SsoErrorKey {
  return (SSO_ERRORS as readonly string[]).includes(code ?? '') ? (code as SsoErrorKey) : 'generic';
}
