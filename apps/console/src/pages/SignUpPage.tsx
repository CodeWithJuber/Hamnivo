import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { MailIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { TextField } from '../components/Fields';
import { EMAIL, PasswordInput } from '../components/SignIn';
import { Turnstile } from '../components/Turnstile';
import { authClient } from '../lib/auth-client';
import { reauth } from '../lib/reauth';
import { useSignupSettings } from '../lib/saas';

/** "Check your email", after signing up or asking for a password reset. */
export function CheckEmail({
  email,
  kind,
  onResend,
}: {
  email: string;
  kind: 'verify' | 'reset';
  onResend: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  return (
    <div className="flex flex-col gap-5" data-testid="check-email">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-info-subtle text-info">
          <MailIcon className="size-5" aria-hidden="true" />
        </span>
        <p className="text-sm text-text">
          {t(kind === 'verify' ? 'auth.checkEmail.verify' : 'auth.checkEmail.reset', {
            email,
          })}
        </p>
      </div>
      <p className="text-sm text-text-secondary">{t('auth.checkEmail.help')}</p>
      {sent ? (
        <p role="status" className="text-sm text-success">
          {t('auth.checkEmail.sent')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="secondary"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onResend();
              setSent(true);
              announce(t('auth.checkEmail.sent'));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('auth.checkEmail.resend')}
        </Button>
        <Button asChild variant="link">
          <Link to="/sign-in">{t('auth.checkEmail.back')}</Link>
        </Button>
      </div>
    </div>
  );
}

/** Create an account; with email verification on, the next step is "check your email". */
export function SignUpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [verify, setVerify] = useState<string | null>(null);
  // Cloudflare Turnstile, when the server turned it on: a token per attempt.
  const signup = useSignupSettings();
  const siteKey = signup.data?.turnstileSiteKey ?? null;
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const callbackURL = `${window.location.origin}/tenants`;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('auth.signUp.nameRequired');
    if (!email.trim()) next.email = t('auth.emailRequired');
    else if (!EMAIL.test(email.trim())) next.email = t('auth.emailInvalid');
    if (password.length < 12) next.password = t('auth.signUp.passwordShort');
    else if (password.length > 256) next.password = t('auth.signUp.passwordLong');
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (siteKey && !captcha) {
      const text = t('billing.signup.captchaMissing');
      setFailure(text);
      announce(text, 'assertive');
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const { data, error } = await authClient.signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
        callbackURL,
        ...(captcha ? { fetchOptions: { headers: { 'x-captcha-response': captcha } } } : {}),
      });
      if (error) {
        const text =
          error.status === 429
            ? t('auth.rateLimited')
            : error.code === 'SIGNUP_CLOSED'
              ? t('billing.signup.closedError')
              : error.code === 'MISSING_RESPONSE'
                ? t('billing.signup.captchaMissing')
                : error.code === 'VERIFICATION_FAILED'
                  ? t('billing.signup.captchaFailed')
                  : t('auth.signUp.failed');
        setFailure(text);
        announce(text, 'assertive');
        // A Turnstile token works once: the next attempt needs a new check.
        if (siteKey) {
          setCaptcha(null);
          setAttempt((n) => n + 1);
        }
        return;
      }
      setPassword('');
      // No session yet means the address must be confirmed first.
      if (!data?.token) {
        setVerify(email.trim());
        return;
      }
      client.clear();
      reauth.resume();
      await navigate({ to: '/tenants' });
    } catch {
      setFailure(t('errors.network.title'));
    } finally {
      setBusy(false);
    }
  };

  if (verify) {
    return (
      <AuthLayout title={t('auth.checkEmail.title')}>
        <CheckEmail
          email={verify}
          kind="verify"
          onResend={() => authClient.sendVerificationEmail({ email: verify, callbackURL })}
        />
      </AuthLayout>
    );
  }

  const summary = attempted
    ? Object.entries(errors).map(([field, message]) => ({ fieldId: `sign-up-${field}`, message }))
    : [];

  return (
    <AuthLayout title={t('auth.signUp.title')} description={t('auth.signUp.description')}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
        {signup.data?.open === false ? (
          <p
            className="rounded-lg border border-info/30 bg-info-subtle p-3 text-sm text-text"
            data-testid="signup-closed"
          >
            {t('billing.signup.closed')}
          </p>
        ) : null}
        {failure ? (
          <p role="alert" className="text-sm text-danger">
            {failure}
          </p>
        ) : null}
        <TextField
          id="sign-up-name"
          label={t('auth.signUp.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          error={errors.name}
        />
        <TextField
          id="sign-up-email"
          label={t('auth.email')}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          dir="ltr"
          error={errors.email}
        />
        <PasswordInput
          id="sign-up-password"
          label={t('auth.password')}
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={t('auth.signUp.passwordHint')}
          error={errors.password}
        />
        {siteKey ? <Turnstile key={attempt} siteKey={siteKey} onToken={setCaptcha} /> : null}
        <Button type="submit" busy={busy} className="w-full">
          {t('auth.signUp.submit')}
        </Button>
        <p className="text-sm text-text-secondary">
          {t('auth.signUp.haveAccount')}{' '}
          <Link to="/sign-in" className="text-link underline underline-offset-4 hover:no-underline">
            {t('auth.signUp.signIn')}
          </Link>
        </p>
        <p className="border-t border-border pt-4 text-xs text-text-secondary">
          {t('auth.privacy')}
        </p>
      </form>
    </AuthLayout>
  );
}
