import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { StatusBadge } from '@hamnivo/ui/components/status-badge';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FingerprintIcon, KeyRoundIcon, ShieldCheckIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyButton } from '../components/CopyButton';
import { PageHeader, Section } from '../components/PageHeader';
import { CodeInput, PasswordInput } from '../components/SignIn';
import { QueryState } from '../components/States';
import { authClient, passkeysAvailable } from '../lib/auth-client';
import { formatDateTime } from '../lib/format';
import { useTenant } from '../lib/tenant';

interface Setup {
  uri: string;
  secret: string;
  backupCodes: string[];
}

/** TOTP two-factor authentication: turn on with a verified code, or off with the password. */
function TwoFactorSection() {
  const { t } = useTranslation();
  const { me } = useTenant();
  const client = useQueryClient();
  const announce = useAnnouncer();
  const enabled = me.user.twoFactorEnabled;
  const [step, setStep] = useState<'idle' | 'password' | 'verify'>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const finish = async (message: string) => {
    setStep('idle');
    setSetup(null);
    setPassword('');
    setCode('');
    setDone(message);
    announce(message);
    await client.invalidateQueries({ queryKey: ['me'] });
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return setError(t('auth.passwordRequired'));
    setBusy(true);
    setError(undefined);
    try {
      if (enabled) {
        const { error: failed } = await authClient.twoFactor.disable({ password });
        if (failed) return setError(t('account.twoFactor.wrongPassword'));
        await finish(t('account.twoFactor.disabled'));
        return;
      }
      const { data, error: failed } = await authClient.twoFactor.enable({ password });
      if (failed || !data || !('totpURI' in data)) {
        return setError(t('account.twoFactor.wrongPassword'));
      }
      const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
      setSetup({ uri: data.totpURI, secret, backupCodes: data.backupCodes });
      setPassword('');
      setStep('verify');
    } catch {
      setError(t('errors.network.title'));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length < 6) return setError(t('auth.twoFactor.codeRequired'));
    setBusy(true);
    setError(undefined);
    try {
      const { error: failed } = await authClient.twoFactor.verifyTotp({ code });
      if (failed) {
        setCode('');
        return setError(t('auth.twoFactor.invalid'));
      }
      await finish(t('account.twoFactor.enabled'));
    } catch {
      setError(t('errors.network.title'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      id="account-2fa"
      title={t('account.twoFactor.title')}
      description={t('account.twoFactor.description')}
      actions={
        <StatusBadge tone={enabled ? 'success' : 'neutral'} data-testid="two-factor-status">
          {enabled ? t('account.twoFactor.on') : t('account.twoFactor.off')}
        </StatusBadge>
      }
    >
      {done ? (
        <p role="status" className="text-sm text-success">
          {done}
        </p>
      ) : null}
      {step === 'idle' ? (
        <Button
          variant={enabled ? 'secondary' : 'default'}
          className="self-start"
          onClick={() => {
            setStep('password');
            setDone(null);
            setError(undefined);
          }}
        >
          <ShieldCheckIcon aria-hidden="true" />
          {enabled ? t('account.twoFactor.disable') : t('account.twoFactor.enable')}
        </Button>
      ) : null}
      {step === 'password' ? (
        <form className="flex max-w-md flex-col gap-4" onSubmit={submitPassword} noValidate>
          {enabled ? (
            <p className="text-sm text-text">{t('account.twoFactor.disableBody')}</p>
          ) : null}
          <PasswordInput
            id="account-password"
            label={t('account.twoFactor.password')}
            hint={t('account.twoFactor.passwordHint')}
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            error={error}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy} variant={enabled ? 'destructive-solid' : 'default'}>
              {enabled ? t('account.twoFactor.disable') : t('account.twoFactor.enable')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep('idle')}>
              {t('app.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
      {step === 'verify' && setup ? (
        <form
          className="flex flex-col gap-5"
          onSubmit={verify}
          noValidate
          data-testid="two-factor-setup"
        >
          <div className="flex flex-col gap-2">
            <h3 className="text-md font-semibold text-text">{t('account.twoFactor.setupTitle')}</h3>
            <p className="text-sm text-text-secondary">{t('account.twoFactor.setupBody')}</p>
            <p className="text-sm">
              {t('account.twoFactor.secret')}:{' '}
              <bdi dir="ltr" className="font-mono break-all text-text" data-testid="totp-secret">
                {setup.secret}
              </bdi>
            </p>
            <a
              href={setup.uri}
              className="w-fit text-sm text-link underline underline-offset-4 hover:no-underline"
            >
              {t('account.twoFactor.openApp')}
            </a>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-md font-semibold text-text">
              {t('account.twoFactor.backupTitle')}
            </h3>
            <p className="text-sm text-text-secondary">{t('account.twoFactor.backupBody')}</p>
            <ul dir="ltr" className="grid w-fit grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm">
              {setup.backupCodes.map((backup) => (
                <li key={backup}>{backup}</li>
              ))}
            </ul>
            <CopyButton
              text={setup.backupCodes.join('\n')}
              label={t('account.twoFactor.copyCodes')}
              copiedLabel={t('app.copied')}
              failedLabel={t('brands.install.copyFailed')}
            />
          </div>
          <CodeInput
            id="account-code"
            label={t('auth.twoFactor.code')}
            hint={t('auth.twoFactor.codeHint')}
            value={code}
            onChange={setCode}
            error={error}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy}>
              {t('account.twoFactor.verify')}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStep('idle')}>
              {t('app.cancel')}
            </Button>
          </div>
        </form>
      ) : null}
    </Section>
  );
}

interface Passkey {
  id: string;
  name?: string | null;
  createdAt: string | Date;
}

function PasskeysSection() {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      if (error) throw new Error(error.message ?? 'passkeys');
      return (data ?? []) as Passkey[];
    },
  });
  return (
    <Section
      id="account-passkeys"
      title={t('account.passkeys.title')}
      description={t('account.passkeys.description')}
    >
      {message ? (
        <p
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className={message.tone === 'ok' ? 'text-sm text-success' : 'text-sm text-danger'}
        >
          {message.text}
        </p>
      ) : null}
      <QueryState
        query={passkeys}
        label={t('account.passkeys.loading')}
        isEmpty={(items) => items.length === 0}
        empty={<p className="text-sm text-text-secondary">{t('account.passkeys.none')}</p>}
      >
        {(items) => (
          <ul className="flex flex-col gap-2">
            {items.map((passkey) => (
              <li
                key={passkey.id}
                className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <KeyRoundIcon className="size-4 text-text-muted" aria-hidden="true" />
                <span className="font-medium">{passkey.name || t('account.passkeys.unnamed')}</span>
                <span className="text-text-secondary">
                  {t('account.passkeys.created', {
                    time: formatDateTime(new Date(passkey.createdAt).toISOString()),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {passkeysAvailable() ? (
        <Button
          variant="secondary"
          className="self-start"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setMessage(null);
            try {
              const result = await authClient.passkey.addPasskey();
              if (result?.error) throw new Error(result.error.message ?? 'passkey');
              setMessage({ tone: 'ok', text: t('account.passkeys.added') });
              announce(t('account.passkeys.added'));
              await passkeys.refetch();
            } catch {
              setMessage({ tone: 'error', text: t('account.passkeys.failed') });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? null : <FingerprintIcon aria-hidden="true" />}
          {t('account.passkeys.add')}
        </Button>
      ) : (
        <p className="text-sm text-text-secondary">{t('account.passkeys.unsupported')}</p>
      )}
    </Section>
  );
}

/** How the signed-in person proves who they are (board 02 security settings). */
export function AccountPage() {
  const { t } = useTranslation();
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader title={t('account.title')} description={t('account.description')} />
      <TwoFactorSection />
      <PasskeysSection />
    </div>
  );
}
