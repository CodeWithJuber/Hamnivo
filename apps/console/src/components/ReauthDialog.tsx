import { Button } from '@hamnivo/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@hamnivo/ui/components/dialog';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClockIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient } from '../lib/auth-client';
import { returnFocus, useOpener } from '../lib/focus';
import { meQuery } from '../lib/queries';
import { reauth } from '../lib/reauth';
import { SignInFlow } from './SignIn';

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

  useEffect(() => {
    if (!expired) return;
    document.documentElement.dataset.masked = 'true';
    return () => {
      delete document.documentElement.dataset.masked;
    };
  }, [expired]);

  if (!request) return null;
  const email = me.data?.user.email;

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
          onSignedIn={async () => {
            await client.invalidateQueries({ queryKey: ['me'] });
            reauth.succeed();
          }}
        />
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
