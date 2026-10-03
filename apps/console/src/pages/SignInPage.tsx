import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { Separator } from '@hamnivo/ui/components/separator';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { AlertCircleIcon, LockIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { TextField } from '../components/Fields';
import { EMAIL, PasskeyButton, SignInFlow } from '../components/SignIn';
import { passkeysAvailable } from '../lib/auth-client';
import { ssoErrorKey, startSso } from '../lib/sso';

/** "Continue with single sign-on": the work address decides which identity provider opens. */
function SsoForm({
  initialEmail,
  next,
  onBack,
}: {
  initialEmail: string;
  next: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [email, setEmail] = useState(initialEmail);
  const [error, setError] = useState<string | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!EMAIL.test(email.trim())) {
      setError(t('auth.emailInvalid'));
      return;
    }
    setError(undefined);
    setMessage(null);
    setBusy(true);
    const started = await startSso(email, `/sso/done?next=${encodeURIComponent(next)}`, '/sign-in');
    if ('url' in started) {
      window.location.assign(started.url);
      return;
    }
    setBusy(false);
    const text =
      started.error === 'not_set_up'
        ? t('sso.notSetUp')
        : started.error === 'rate_limited'
          ? t('auth.rateLimited')
          : started.error === 'network'
            ? t('errors.network.title')
            : t('sso.failed');
    setMessage(text);
    announce(text, 'assertive');
  };

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate data-testid="sso-form">
      {message ? (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      ) : null}
      <TextField
        id="sso-email"
        type="email"
        label={t('sso.email')}
        hint={t('sso.emailHint')}
        value={email}
        autoComplete="username"
        dir="ltr"
        onChange={(event) => setEmail(event.target.value)}
        error={error}
      />
      <Button type="submit" busy={busy} className="w-full">
        {t('sso.submit')}
      </Button>
      <Button type="button" variant="link" className="h-auto self-start p-0" onClick={onBack}>
        {t('sso.back')}
      </Button>
    </form>
  );
}

/** Sign in (board 02: HNV-02-01 default, HNV-02-02 submitting, HNV-02-03/04 verification). */
export function SignInPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/sign-in' });
  const client = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [sso, setSso] = useState<{ email: string } | null>(null);
  const next = search.redirect ?? '/overview';

  const signedIn = async () => {
    // A new person may be signing in on this browser: drop everything cached before.
    client.clear();
    await router.navigate({ href: next });
  };

  if (sso) {
    return (
      <AuthLayout title={t('sso.continue')}>
        <SsoForm initialEmail={sso.email} next={next} onBack={() => setSso(null)} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title={step === 'code' ? t('auth.twoFactor.title') : t('auth.signIn.title')}
      description={step === 'code' ? undefined : t('auth.signIn.description')}
    >
      <div className="flex flex-col gap-6">
        {search.error && step === 'password' ? (
          <p
            role="alert"
            data-testid="sso-error"
            className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm text-text"
          >
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            {t(`sso.errors.${ssoErrorKey(search.error)}`)}
          </p>
        ) : null}
        <SignInFlow
          idPrefix="sign-in"
          submitLabel={t('auth.signIn.submit')}
          showRemember
          showCodeTitle={false}
          onSignedIn={signedIn}
          onStepChange={setStep}
          onSsoRequired={(email) => setSso({ email })}
          footer={
            <Link
              to="/forgot-password"
              className="self-start text-sm text-link underline underline-offset-4 hover:no-underline"
            >
              {t('auth.signIn.forgot')}
            </Link>
          }
        />
        {step === 'password' ? (
          <>
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Separator className="flex-1" />
              <span>{t('auth.signIn.or')}</span>
              <Separator className="flex-1" />
            </div>
            <div className="flex flex-col gap-3">
              {passkeysAvailable() ? <PasskeyButton onSignedIn={signedIn} /> : null}
              <Button
                type="button"
                variant="secondary"
                className="w-full"
                onClick={() => setSso({ email: '' })}
                data-testid="continue-with-sso"
              >
                <LockIcon aria-hidden="true" />
                {t('sso.continue')}
              </Button>
            </div>
          </>
        ) : null}
        {step === 'password' ? (
          <p className="text-sm text-text-secondary">
            {t('auth.signIn.noAccount')}{' '}
            <Link
              to="/sign-up"
              className="text-link underline underline-offset-4 hover:no-underline"
            >
              {t('auth.signIn.createAccount')}
            </Link>
          </p>
        ) : null}
        <p className="border-t border-border pt-4 text-xs text-text-secondary">
          {t('auth.privacy')}
        </p>
      </div>
    </AuthLayout>
  );
}
