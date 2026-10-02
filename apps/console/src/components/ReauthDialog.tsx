import { Button } from '@hamnivo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@hamnivo/ui/components/dialog';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Separator } from '@hamnivo/ui/components/separator';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClockIcon, LockIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { authClient, passkeysAvailable } from '../lib/auth-client';
import { returnFocus, useOpener } from '../lib/focus';
import { meQuery } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { lastSignInMethod, ssoErrorKey, ssoInPopup } from '../lib/sso';
import type { Me } from '../lib/types';
import { PasskeyButton, SignInFlow } from './SignIn';

/**
 * Signing in again with single sign-on, in a small window so the page stays as it is (A13). Shown
 * when this browser last signed in that way, or when the address turns out to require it.
 */
function SsoAgain({ email, onSignedIn }: { email: string; onSignedIn: () => Promise<void> }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        busy={busy}
        className="w-full"
        data-testid="reauth-sso"
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await ssoInPopup(email);
          setBusy(false);
          if (result.ok) {
            reauth.resume();
            await onSignedIn();
            return;
          }
          if (result.error === 'closed') return;
          const text =
            result.error === 'popup_blocked'
              ? t('sso.popupBlocked')
              : result.error === 'not_set_up'
                ? t('sso.notSetUp')
                : t(`sso.errors.${ssoErrorKey(result.error)}`);
          setError(text);
          announce(text, 'assertive');
        }}
      >
        {busy ? null : <LockIcon aria-hidden="true" />}
        {t('reauthMore.sso')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Sign-in-again dialog (HNV-02-05). A sensitive action whose sign-in is too old ("step-up") or a
 * session that ended ("expired") opens it over the page; the page and its unsaved work stay
 * underneath and the action is repeated after a successful sign-in. When the session ended, the
 * workspace behind the dialog is blurred, not only dimmed.
 */
export function ReauthDialog() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const request = useSyncExternalStore(reauth.subscribe, reauth.snapshot);
  // Whatever is cached; the dialog must not wait on a request that needs the missing session.
  const me = useQuery({ ...meQuery(), enabled: false });
  const expired = request?.reason === 'expired';
  const opener = useOpener(request !== null);
  const [ssoNeeded, setSsoNeeded] = useState(false);

  useEffect(() => {
    if (!expired) return;
    document.documentElement.dataset.masked = 'true';
    return () => {
      delete document.documentElement.dataset.masked;
    };
  }, [expired]);

  if (!request) return null;
  const email = me.data?.user.email;
  const signedIn = async () => {
    // A passkey or an identity provider can sign in a different account: never continue the
    // page as someone else.
    const current = await api<Me>('/v1/me').catch(() => null);
    if (email && current && current.user.email.toLowerCase() !== email.toLowerCase()) {
      await leave();
      return;
    }
    await client.invalidateQueries({ queryKey: ['me'] });
    reauth.succeed();
  };

  const leave = async () => {
    await authClient.signOut().catch(() => undefined);
    client.clear();
    reauth.cancel();
    window.location.assign('/sign-in');
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open) return;
        if (expired) void leave();
        else reauth.cancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="reauth-dialog"
        data-reason={request.reason}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        onEscapeKeyDown={(event) => {
          // An ended session can't be dismissed without leaving; Escape does nothing then.
          if (expired) event.preventDefault();
        }}
        onInteractOutside={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          // Back to the control whose action asked for the sign-in (it is repeated now).
          event.preventDefault();
          returnFocus(opener.current);
        }}
      >
        <DialogHeader className="text-start sm:text-start">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-subtle text-warning">
              {expired ? (
                <ClockIcon className="size-5" aria-hidden="true" />
              ) : (
                <ShieldCheckIcon className="size-5" aria-hidden="true" />
              )}
            </span>
            <DialogTitle className="leading-snug">
              {expired ? t('auth.reauth.expiredTitle') : t('auth.reauth.stepUpTitle')}
            </DialogTitle>
          </div>
          <DialogDescription className="text-text-secondary">
            {expired ? t('auth.reauth.expiredDescription') : t('auth.reauth.stepUpDescription')}
          </DialogDescription>
        </DialogHeader>
        <SignInFlow
          idPrefix="reauth"
          {...(email ? { fixedEmail: email } : {})}
          submitLabel={expired ? t('auth.reauth.signInAgain') : t('auth.reauth.confirm')}
          showRemember={false}
          onSignedIn={signedIn}
          onSsoRequired={() => setSsoNeeded(true)}
        />
        {passkeysAvailable() || (email && (ssoNeeded || lastSignInMethod() === 'sso')) ? (
          <div className="flex flex-col gap-3" data-testid="reauth-other-ways">
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Separator className="flex-1" />
              <span>{t('reauthMore.otherWays')}</span>
              <Separator className="flex-1" />
            </div>
            {email && (ssoNeeded || lastSignInMethod() === 'sso') ? (
              <SsoAgain email={email} onSignedIn={signedIn} />
            ) : null}
            {passkeysAvailable() ? (
              <PasskeyButton onSignedIn={signedIn} label={t('reauthMore.passkey')} />
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-4">
          {expired ? (
            <>
              <p className="text-sm text-text-secondary">{t('auth.reauth.masked')}</p>
              <Button variant="link" className="h-auto p-0" onClick={() => void leave()}>
                {t('auth.reauth.otherAccount')}
              </Button>
            </>
          ) : (
            <Button variant="secondary" className="ms-auto" onClick={() => reauth.cancel()}>
              {t('app.cancel')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
