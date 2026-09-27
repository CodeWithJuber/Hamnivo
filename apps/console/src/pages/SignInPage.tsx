import { Separator } from '@hamnivo/ui/components/separator';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AuthLayout } from '../components/AuthLayout';
import { PasskeyButton, SignInFlow } from '../components/SignIn';
import { passkeysAvailable } from '../lib/auth-client';

/** Sign in (board 02: HNV-02-01 default, HNV-02-02 submitting, HNV-02-03/04 verification). */
export function SignInPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/sign-in' });
  const client = useQueryClient();
  const router = useRouter();
  const [step, setStep] = useState<'password' | 'code'>('password');

  const signedIn = async () => {
    // A new person may be signing in on this browser: drop everything cached before.
    client.clear();
    await router.navigate({ href: search.redirect ?? '/overview' });
  };

  return (
    <AuthLayout
      title={step === 'code' ? t('auth.twoFactor.title') : t('auth.signIn.title')}
      description={step === 'code' ? undefined : t('auth.signIn.description')}
    >
      <div className="flex flex-col gap-6">
        <SignInFlow
          idPrefix="sign-in"
          submitLabel={t('auth.signIn.submit')}
          showRemember
          showCodeTitle={false}
          onSignedIn={signedIn}
          onStepChange={setStep}
          footer={
            <Link
              to="/forgot-password"
              className="self-start text-sm text-link underline underline-offset-4 hover:no-underline"
            >
              {t('auth.signIn.forgot')}
            </Link>
          }
        />
        {step === 'password' && passkeysAvailable() ? (
          <>
            <div className="flex items-center gap-3 text-sm text-text-muted">
              <Separator className="flex-1" />
              <span>{t('auth.signIn.or')}</span>
              <Separator className="flex-1" />
            </div>
            <PasskeyButton onSignedIn={signedIn} />
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
