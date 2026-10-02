import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@hamnivo/ui/components/field';
import { FormErrorSummary } from '@hamnivo/ui/components/form-error-summary';
import { Input } from '@hamnivo/ui/components/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@hamnivo/ui/components/input-otp';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import { EyeIcon, EyeOffIcon, FingerprintIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authClient, passkeysAvailable } from '../lib/auth-client';
import { reauth } from '../lib/reauth';
import { rememberSignInMethod } from '../lib/sso';
import { CheckboxField, describedBy } from './Fields';

const REMEMBER_KEY = 'hamnivo.studio.remember';

/** The "keep me signed in" choice, reused when someone signs in again mid-task. */
export function rememberChoice(): boolean {
  try {
    return window.localStorage.getItem(REMEMBER_KEY) !== '0';
  } catch {
    return true;
  }
}

function saveRememberChoice(value: boolean) {
  try {
    window.localStorage.setItem(REMEMBER_KEY, value ? '1' : '0');
  } catch {
    // Not stored: the default (remembered) applies next time.
  }
}

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function PasswordInput({
  id,
  value,
  onChange,
  error,
  hint,
  autoComplete,
  inputRef,
  label,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  autoComplete: 'current-password' | 'new-password';
  inputRef?: React.Ref<HTMLInputElement>;
  label: string;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          ref={inputRef}
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className="flex-1"
          dir="ltr"
        />
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={t('auth.showPassword')}
          aria-pressed={visible}
          aria-controls={id}
          title={visible ? t('auth.hidePassword') : t('auth.showPassword')}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </Button>
      </div>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A 6-digit code. Codes read left to right in every language. */
export function CodeInput({
  id,
  value,
  onChange,
  error,
  label,
  hint,
  onComplete,
  inputRef,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  label: string;
  hint?: ReactNode;
  onComplete?: () => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div dir="ltr" className="flex justify-start">
        <InputOTP
          ref={inputRef}
          id={id}
          maxLength={6}
          value={value}
          onChange={onChange}
          inputMode="numeric"
          pattern="^[0-9]*$"
          autoComplete="one-time-code"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...(onComplete ? { onComplete } : {})}
        >
          <InputOTPGroup>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <InputOTPSlot key={index} index={index} aria-invalid={error ? true : undefined} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

type Step = 'password' | 'code';
type Message = { text: string; action?: ReactNode } | null;

interface AuthResultError {
  code?: string | undefined;
  status: number;
}

/**
 * Email and password, then a code when the account has two-factor authentication (HNV-02-01 to
 * HNV-02-04). Used on the sign-in page and in the sign-in-again dialog, where the account is fixed.
 */
export function SignInFlow({
  idPrefix,
  fixedEmail,
  submitLabel,
  showRemember,
  onSignedIn,
  onStepChange,
  footer,
  showCodeTitle = true,
  onSsoRequired,
}: {
  idPrefix: string;
  fixedEmail?: string;
  submitLabel: string;
  showRemember: boolean;
  onSignedIn: () => void | Promise<void>;
  onStepChange?: (step: Step) => void;
  footer?: ReactNode;
  /** The sign-in page names the code step in its own heading instead. */
  showCodeTitle?: boolean;
  /** The address must use single sign-on (A13): offer it instead of the password. */
  onSsoRequired?: (email: string) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const uid = useId();
  const base = `${idPrefix}-${uid.replace(/:/g, '')}`;
  const [step, setStepState] = useState<Step>('password');
  const [email, setEmail] = useState(fixedEmail ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(rememberChoice());
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const setStep = (next: Step) => {
    setStepState(next);
    onStepChange?.(next);
  };

  const fail = (text: string, action?: ReactNode) => {
    setMessage(action ? { text, action } : { text });
    announce(text, 'assertive');
  };

  const finish = async () => {
    setPassword('');
    setCode('');
    reauth.resume();
    rememberSignInMethod('password');
    await onSignedIn();
  };

  const signInError = (error: AuthResultError) => {
    if (error.status === 429) return fail(t('auth.rateLimited'));
    if (error.code === 'SSO_REQUIRED') {
      setPassword('');
      return fail(
        t('sso.required'),
        onSsoRequired ? (
          <Button
            type="button"
            variant="link"
            className="h-auto self-start p-0"
            onClick={() => onSsoRequired(email.trim())}
            data-testid="sso-required-continue"
          >
            {t('sso.short')}
          </Button>
        ) : undefined,
      );
    }
    if (error.code === 'EMAIL_NOT_VERIFIED') {
      return fail(
        t('auth.signIn.notVerified'),
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          onClick={async () => {
            await authClient.sendVerificationEmail({
              email: email.trim(),
              callbackURL: `${window.location.origin}/tenants`,
            });
            setMessage({ text: t('auth.signIn.verificationSent') });
            announce(t('auth.signIn.verificationSent'));
          }}
        >
          {t('auth.signIn.resendVerification')}
        </Button>,
      );
    }
    // The same words for a wrong password and an unknown address (no account enumeration).
    fail(t('auth.signIn.failed'));
    passwordRef.current?.focus();
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    const errors: Record<string, string> = {};
    if (!email.trim()) errors.email = t('auth.emailRequired');
    else if (!EMAIL.test(email.trim())) errors.email = t('auth.emailInvalid');
    if (!password) errors.password = t('auth.passwordRequired');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setMessage(null);
    try {
      if (showRemember) saveRememberChoice(remember);
      const { data, error } = await authClient.signIn.email({
        email: email.trim(),
        password,
        rememberMe: showRemember ? remember : rememberChoice(),
      });
      if (error) {
        signInError(error);
        return;
      }
      if ((data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        setStep('code');
        setAttempted(false);
        setFieldErrors({});
        requestAnimationFrame(() => codeRef.current?.focus());
        return;
      }
      await finish();
    } catch {
      fail(t('errors.network.title'));
    } finally {
      setBusy(false);
    }
  };

  const backToPassword = (text?: string) => {
    setStep('password');
    setCode('');
    setBackup(false);
    setPassword('');
    if (text) fail(text);
    requestAnimationFrame(() => passwordRef.current?.focus());
  };

  const submitCode = async (event?: FormEvent) => {
    event?.preventDefault();
    setAttempted(true);
    const value = code.trim();
    if (!value) {
      setFieldErrors({ code: t('auth.twoFactor.codeRequired') });
      return;
    }
    setFieldErrors({});
    setBusy(true);
    setMessage(null);
    try {
      const { error } = backup
        ? await authClient.twoFactor.verifyBackupCode({ code: value })
        : await authClient.twoFactor.verifyTotp({ code: value });
      if (error) {
        if (error.code === 'INVALID_TWO_FACTOR_COOKIE') backToPassword(t('auth.twoFactor.expired'));
        else if (
          error.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' ||
          error.code === 'ACCOUNT_TEMPORARILY_LOCKED' ||
          error.status === 429
        ) {
          backToPassword(t('auth.twoFactor.tooMany'));
        } else {
          setCode('');
          fail(t('auth.twoFactor.invalid'));
          requestAnimationFrame(() => codeRef.current?.focus());
        }
        return;
      }
      await finish();
    } catch {
      fail(t('errors.network.title'));
    } finally {
      setBusy(false);
    }
  };

  const summary = attempted
    ? Object.entries(fieldErrors).map(([field, text]) => ({
        fieldId: `${base}-${field}`,
        message: text,
      }))
    : [];

  if (step === 'code') {
    return (
      <form className="flex flex-col gap-5" onSubmit={submitCode} noValidate data-step="code">
        <div className="flex flex-col gap-1">
          {showCodeTitle ? (
            <p className="text-md font-semibold text-text">{t('auth.twoFactor.title')}</p>
          ) : null}
          <p className="text-sm text-text-secondary">
            {backup ? t('auth.twoFactor.backupHint') : t('auth.twoFactor.description')}
          </p>
        </div>
        {message ? (
          <p role="alert" className="text-sm text-danger">
            {message.text}
          </p>
        ) : null}
        {backup ? (
          <Field data-invalid={fieldErrors.code ? true : undefined} className="gap-2">
            <FieldLabel htmlFor={`${base}-code`}>{t('auth.twoFactor.backupCode')}</FieldLabel>
            <Input
              ref={codeRef}
              id={`${base}-code`}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              dir="ltr"
              aria-invalid={fieldErrors.code ? true : undefined}
              aria-describedby={describedBy(`${base}-code`, false, fieldErrors.code)}
            />
            {fieldErrors.code ? (
              <FieldError id={`${base}-code-error`}>{fieldErrors.code}</FieldError>
            ) : null}
          </Field>
        ) : (
          <CodeInput
            inputRef={codeRef}
            id={`${base}-code`}
            value={code}
            onChange={setCode}
            error={fieldErrors.code}
            label={t('auth.twoFactor.code')}
            hint={t('auth.twoFactor.codeHint')}
          />
        )}
        <Button type="submit" busy={busy} className="w-full">
          {t('auth.twoFactor.submit')}
        </Button>
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => {
              setBackup((v) => !v);
              setCode('');
              setFieldErrors({});
              requestAnimationFrame(() => codeRef.current?.focus());
            }}
          >
            {backup ? t('auth.twoFactor.useApp') : t('auth.twoFactor.useBackup')}
          </Button>
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={() => backToPassword()}
          >
            {t('auth.twoFactor.back')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submitPassword} noValidate data-step="password">
      <FormErrorSummary title={t('auth.errorSummary')} errors={summary} />
      {message ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-danger">
          <p>{message.text}</p>
          {message.action}
        </div>
      ) : null}
      {fixedEmail ? (
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-text">{t('auth.reauth.account')}</span>
          <bdi dir="ltr" className="text-text-secondary">
            {fixedEmail}
          </bdi>
        </div>
      ) : (
        <Field data-invalid={fieldErrors.email ? true : undefined} className="gap-2">
          <FieldLabel htmlFor={`${base}-email`}>{t('auth.email')}</FieldLabel>
          <Input
            id={`${base}-email`}
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            dir="ltr"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={describedBy(`${base}-email`, false, fieldErrors.email)}
          />
          {fieldErrors.email ? (
            <FieldError id={`${base}-email-error`}>{fieldErrors.email}</FieldError>
          ) : null}
        </Field>
      )}
      <PasswordInput
        id={`${base}-password`}
        label={t('auth.password')}
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
        autoComplete="current-password"
        inputRef={passwordRef}
      />
      {showRemember ? (
        <CheckboxField
          id={`${base}-remember`}
          label={t('auth.signIn.keepSignedIn')}
          hint={t('auth.signIn.keepSignedInHint')}
          checked={remember}
          onCheckedChange={setRemember}
        />
      ) : null}
      <Button type="submit" busy={busy} className="w-full">
        {submitLabel}
      </Button>
      {footer}
    </form>
  );
}

/** Passkey sign-in (the gateway's passkey plugin); shown only where the browser supports it. */
export function PasskeyButton({
  onSignedIn,
  label,
}: {
  onSignedIn: () => void | Promise<void>;
  label?: string;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!passkeysAvailable()) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        busy={busy}
        className="w-full"
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await authClient.signIn.passkey();
            if (result?.error) {
              // An address that must use single sign-on can't use a passkey either (A13).
              const text =
                'code' in result.error && result.error.code === 'SSO_REQUIRED'
                  ? t('sso.required')
                  : t('auth.signIn.passkeyFailed');
              setError(text);
              announce(text, 'assertive');
              return;
            }
            reauth.resume();
            rememberSignInMethod('passkey');
            await onSignedIn();
          } catch {
            setError(t('auth.signIn.passkeyFailed'));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? null : <FingerprintIcon aria-hidden="true" />}
        {label ?? t('auth.signIn.passkey')}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
