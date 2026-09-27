import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Link, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { TextField } from '../components/Fields';
import { EMAIL, PasswordInput } from '../components/SignIn';
import { authClient } from '../lib/auth-client';
import { CheckEmail } from './SignUpPage';

const resetPage = () => `${window.location.origin}/reset-password`;

/** Ask for a reset link. The answer never reveals whether the address has an account. */
export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const request = (address: string) =>
    authClient.requestPasswordReset({ email: address, redirectTo: resetPage() });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = email.trim();
    if (!value) return setError(t('auth.emailRequired'));
    if (!EMAIL.test(value)) return setError(t('auth.emailInvalid'));
    setError(undefined);
    setBusy(true);
    try {
      await request(value);
      setSentTo(value);
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <AuthLayout title={t('auth.checkEmail.title')}>
        <CheckEmail email={sentTo} kind="reset" onResend={() => request(sentTo)} />
      </AuthLayout>
    );
  }
  return (
    <AuthLayout title={t('auth.forgot.title')} description={t('auth.forgot.description')}>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <TextField
          id="forgot-email"
          label={t('auth.email')}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          dir="ltr"
          error={error}
        />
        <Button type="submit" busy={busy} className="w-full">
          {t('auth.forgot.submit')}
        </Button>
        <Link
          to="/sign-in"
          className="self-start text-sm text-link underline underline-offset-4 hover:no-underline"
        >
          {t('auth.checkEmail.back')}
        </Link>
      </form>
    </AuthLayout>
  );
}

/** The page the reset email links to (Better Auth adds ?token= or ?error=INVALID_TOKEN). */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/reset-password' });
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<'form' | 'invalid' | 'done'>(
    search.token && !search.error ? 'form' : 'invalid',
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    if (password.length < 12) return setError(t('auth.signUp.passwordShort'));
    if (password.length > 256) return setError(t('auth.signUp.passwordLong'));
    setError(undefined);
    setBusy(true);
    try {
      const { error: failed } = await authClient.resetPassword({
        newPassword: password,
        token: search.token ?? '',
      });
      setPassword('');
      setState(failed ? 'invalid' : 'done');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={t('auth.reset.title')} description={t('auth.reset.description')}>
      {state === 'invalid' ? (
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-sm text-danger">
            {t('auth.reset.invalidLink')}
          </p>
          <Button asChild variant="secondary" className="self-start">
            <Link to="/forgot-password">{t('auth.reset.requestNew')}</Link>
          </Button>
        </div>
      ) : state === 'done' ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-sm text-success">
            {t('auth.reset.done')}
          </p>
          <Button asChild className="self-start">
            <Link to="/sign-in">{t('auth.signUp.signIn')}</Link>
          </Button>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <FormErrorSummary
            title={t('auth.errorSummary')}
            errors={attempted && error ? [{ fieldId: 'reset-password', message: error }] : []}
          />
          <PasswordInput
            id="reset-password"
            label={t('auth.reset.password')}
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint={t('auth.signUp.passwordHint')}
            error={error}
          />
          <Button type="submit" busy={busy} className="w-full">
            {t('auth.reset.submit')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
