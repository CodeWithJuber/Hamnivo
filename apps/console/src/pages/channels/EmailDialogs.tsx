import { Button } from '@hamnivo/ui/components/button';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  KeyRoundIcon,
  SearchIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DialogFooter } from '../../components/AppDialog';
import { CheckboxField, SelectField, TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { QueryState } from '../../components/States';
import {
  applyProvider,
  type ChannelInbox,
  connectEmailBody,
  draftFromSettings,
  EMAIL_PROVIDERS,
  EMAIL_STEPS,
  type EmailDraft,
  type EmailProvider,
  type EmailSettings,
  type EmailStep,
  emailProvider,
  emailStepFields,
  emailStepOf,
  emptyEmailDraft,
  invalidEmailFields,
  providerForAddress,
  SMTP_SECURITY,
  setEmailField,
  updateEmailBody,
  useConnectEmail,
  useEmailSettings,
  useUpdateEmail,
} from '../../lib/channels';
import { DOCS } from '../../lib/docs';
import { isCancelled } from '../../lib/reauth';
import type { Team } from '../../lib/types';
import {
  fieldId,
  GuardedDialog,
  machineText,
  PasswordField,
  StepHeading,
  SwitchRow,
  serverErrors,
  useFocusLater,
} from './ChannelForm';
import { ChannelProblem, SavedNote } from './ChannelNotes';

type Errors = Record<string, string>;
type Patch = (path: string, value: string | boolean) => void;

/** Our own message for a field that fails the check before anything is sent. */
function useFieldMessage() {
  const { t } = useTranslation();
  return (path: string, changingPassword = false): string => {
    if (path === 'name') return t('channels.email.errors.name');
    if (path === 'address') return t('channels.email.errors.address');
    if (path.endsWith('.address')) return t('channels.email.errors.server');
    if (path.endsWith('.port')) return t('channels.email.errors.port');
    if (path.endsWith('.login')) return t('channels.email.errors.login');
    return changingPassword
      ? t('channels.email.errors.newPassword')
      : t('channels.email.errors.password');
  };
}

/** "Use an app password", with where to make one, for providers that ask for it. */
function AppPasswordNote({ provider }: { provider: EmailProvider | undefined }) {
  const { t } = useTranslation();
  if (!provider?.appPasswordUrl || !provider.passwordsWork) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3 text-sm"
      data-testid="app-password"
    >
      <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-text">{t('channels.email.appPassword.title')}</p>
        <p className="text-text">{t('channels.email.appPassword.text')}</p>
        <GuideLink href={provider.appPasswordUrl}>
          {t('channels.email.appPassword.link')} <bdi>({provider.name})</bdi>
        </GuideLink>
      </div>
    </div>
  );
}

/** Microsoft no longer takes passwords: the mailbox is connected in Chatwoot instead. */
function MicrosoftNote() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm"
      data-testid="microsoft-note"
    >
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-text">{t('channels.email.microsoft.title')}</p>
        <p className="text-text" id="email-microsoft-text">
          {t('channels.email.microsoft.text')}
        </p>
      </div>
    </div>
  );
}

/** Server and port side by side on a wide screen; the port is short. */
function ServerRow({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">{children}</div>;
}

function ImapFields({
  prefix,
  draft,
  errors,
  patch,
  password,
}: {
  prefix: string;
  draft: EmailDraft;
  errors: Errors;
  patch: Patch;
  password: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <>
      <ServerRow>
        <TextField
          id={fieldId(prefix, 'imap.address')}
          label={t('channels.email.fields.imapServer')}
          value={draft.imap.address}
          placeholder="imap.example.com"
          maxLength={255}
          error={errors['imap.address']}
          onChange={(event) => patch('imap.address', event.target.value)}
          {...machineText}
        />
        <TextField
          id={fieldId(prefix, 'imap.port')}
          label={t('channels.email.fields.imapPort')}
          value={draft.imap.port}
          inputMode="numeric"
          maxLength={5}
          error={errors['imap.port']}
          onChange={(event) => patch('imap.port', event.target.value)}
          {...machineText}
        />
      </ServerRow>
      <SwitchRow
        id={fieldId(prefix, 'imap.ssl')}
        label={t('channels.email.fields.ssl')}
        hint={t('channels.email.fields.sslHint')}
        checked={draft.imap.ssl}
        onChange={(on) => patch('imap.ssl', on)}
      />
      <TextField
        id={fieldId(prefix, 'imap.login')}
        label={t('channels.email.fields.imapLogin')}
        hint={t('channels.email.fields.loginHint')}
        value={draft.imap.login}
        maxLength={320}
        error={errors['imap.login']}
        onChange={(event) => patch('imap.login', event.target.value)}
        {...machineText}
      />
      {password}
    </>
  );
}

function SmtpServerFields({
  prefix,
  draft,
  errors,
  patch,
}: {
  prefix: string;
  draft: EmailDraft;
  errors: Errors;
  patch: Patch;
}) {
  const { t } = useTranslation();
  const securityId = fieldId(prefix, 'smtp.security');
  return (
    <>
      <ServerRow>
        <TextField
          id={fieldId(prefix, 'smtp.address')}
          label={t('channels.email.fields.smtpServer')}
          value={draft.smtp.address}
          placeholder="smtp.example.com"
          maxLength={255}
          error={errors['smtp.address']}
          onChange={(event) => patch('smtp.address', event.target.value)}
          {...machineText}
        />
        <TextField
          id={fieldId(prefix, 'smtp.port')}
          label={t('channels.email.fields.smtpPort')}
          value={draft.smtp.port}
          inputMode="numeric"
          maxLength={5}
          error={errors['smtp.port']}
          onChange={(event) => patch('smtp.port', event.target.value)}
          {...machineText}
        />
      </ServerRow>
      <SelectField
        id={securityId}
        label={t('channels.email.fields.security')}
        value={draft.smtp.security}
        options={SMTP_SECURITY.map((value) => ({
          value,
          label:
            value === 'starttls'
              ? 'STARTTLS'
              : value === 'tls'
                ? 'SSL/TLS'
                : t('channels.email.fields.securityNone'),
        }))}
        hint={draft.smtp.security === 'none' ? t('channels.email.fields.noneHint') : undefined}
        error={errors['smtp.security']}
        onChange={(event) => patch('smtp.security', event.target.value)}
      />
    </>
  );
}

const STEP_KEYS = { 1: 'address', 2: 'imap', 3: 'smtp', 4: 'answering' } as const;

/**
 * The four steps of Connect email. Its state (passwords too) lives only while the dialog is
 * open: closing the dialog unmounts it and nothing is kept.
 */
function ConnectEmailForm({
  brandId,
  teams,
  onDirtyChange,
  onBusyChange,
  onConnected,
}: {
  brandId: string;
  teams: readonly Team[];
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onConnected: (channel: ChannelInbox) => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const message = useFieldMessage();
  const focusLater = useFocusLater();
  const connect = useConnectEmail(brandId);
  const prefix = 'email-connect';
  const initial = useMemo(() => emptyEmailDraft(t('channels.email.fields.nameDefault')), [t]);
  const [draft, setDraft] = useState<EmailDraft>(initial);
  const [step, setStep] = useState<EmailStep>(1);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [found, setFound] = useState<string | null>(null);
  const provider = emailProvider(draft.provider);
  const microsoft = provider?.passwordsWork === false;

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(connect.isPending), [connect.isPending, onBusyChange]);

  const patch: Patch = (path, value) => {
    setDraft((current) => setEmailField(current, path, value));
    setErrors(({ [path]: _gone, ...rest }) => rest);
  };

  /** Fills in a provider's settings and says what happened. */
  const choose = (next: EmailProvider, say: boolean) => {
    setDraft((current) => applyProvider(current, next));
    setErrors(({ provider: _gone, ...rest }) => rest);
    if (!say) {
      setFound(null);
      return;
    }
    const text =
      next.id === 'custom'
        ? t('channels.email.fields.unknown')
        : next.passwordsWork
          ? t('channels.email.fields.found', { provider: next.name })
          : null;
    setFound(text);
    if (text) announce(text);
  };

  const find = () => {
    if (invalidEmailFields(draft, ['address']).length > 0) {
      setErrors((current) => ({ ...current, address: message('address') }));
      focusLater(fieldId(prefix, 'address'));
      return;
    }
    choose(providerForAddress(draft.address), true);
  };

  /** Checks this step; says what is missing next to each field and focuses the first. */
  const check = (at: EmailStep): boolean => {
    const bad = invalidEmailFields(draft, emailStepFields(at, draft));
    if (bad.length === 0) return true;
    setErrors((current) => ({
      ...current,
      ...Object.fromEntries(bad.map((path) => [path, message(path)])),
    }));
    focusLater(fieldId(prefix, bad[0] as string));
    return false;
  };

  const next = () => {
    setProblem(null);
    if (!check(step)) return;
    if (step === 1) {
      // Not chosen yet: find the provider from the address.
      const chosen = provider ?? providerForAddress(draft.address);
      if (!provider) choose(chosen, true);
      if (!chosen.passwordsWork) {
        setErrors((current) => ({
          ...current,
          provider: t('channels.email.microsoft.blocked'),
        }));
        focusLater(fieldId(prefix, 'provider'));
        return;
      }
    }
    setStep((current) => Math.min(4, current + 1) as EmailStep);
  };

  const submit = async () => {
    setProblem(null);
    for (const at of [1, 2, 3] as const) {
      if (!check(at)) {
        setStep(at);
        return;
      }
    }
    try {
      const channel = await connect.mutateAsync(connectEmailBody(draft));
      onConnected(channel);
    } catch (error) {
      if (isCancelled(error)) return;
      setProblem(error);
      const fields = serverErrors(error);
      if (fields.length === 0) return;
      const sameLogin = draft.sameLogin;
      const smtpLogin = fields.some((f) => f.path === 'smtp.login' || f.path === 'smtp.password');
      if (sameLogin && smtpLogin) {
        // Outgoing mail needs its own login after all: show its fields, filled as they were sent.
        setDraft((current) => ({
          ...current,
          sameLogin: false,
          smtp: { ...current.smtp, login: current.imap.login, password: current.imap.password },
        }));
      }
      setErrors(Object.fromEntries(fields.map((field) => [field.path, field.message])));
      const first = fields.find((field) => emailStepOf(field.path) !== null);
      if (first) {
        setStep(emailStepOf(first.path) as EmailStep);
        focusLater(fieldId(prefix, first.path));
      }
    }
  };

  const stepKey = STEP_KEYS[step];
  const teamOptions = teams.map((team) => ({ value: team.id, label: team.name }));

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      autoComplete="off"
      data-testid="connect-email-form"
      data-step={step}
      onSubmit={(event) => {
        event.preventDefault();
        if (connect.isPending) return;
        if (step < 4) next();
        else void submit();
      }}
    >
      <StepHeading
        step={step}
        total={EMAIL_STEPS.length}
        title={t(`channels.email.connect.steps.${stepKey}`)}
        intro={t(`channels.email.connect.intros.${stepKey}`)}
      />

      {step === 1 ? (
        <div className="flex flex-col gap-4">
          <TextField
            id={fieldId(prefix, 'address')}
            label={t('channels.email.fields.address')}
            hint={t('channels.email.fields.addressHint')}
            type="email"
            value={draft.address}
            maxLength={320}
            error={errors.address}
            onChange={(event) => patch('address', event.target.value)}
            {...machineText}
            autoComplete="email"
          />
          <TextField
            id={fieldId(prefix, 'name')}
            label={t('channels.email.fields.name')}
            hint={t('channels.email.fields.nameHint')}
            value={draft.name}
            maxLength={100}
            error={errors.name}
            onChange={(event) => patch('name', event.target.value)}
          />
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="w-full sm:flex-1">
                <SelectField
                  id={fieldId(prefix, 'provider')}
                  label={t('channels.email.fields.provider')}
                  value={draft.provider}
                  placeholder={t('channels.email.fields.providerNone')}
                  options={EMAIL_PROVIDERS.map((one) => ({
                    value: one.id,
                    label: one.id === 'custom' ? t('channels.email.fields.custom') : one.name,
                  }))}
                  error={errors.provider}
                  onChange={(event) => {
                    const chosen = emailProvider(event.target.value);
                    if (chosen) choose(chosen, false);
                    else setDraft((current) => ({ ...current, provider: '' }));
                  }}
                />
              </div>
              <Button type="button" variant="secondary" data-testid="find-settings" onClick={find}>
                <SearchIcon aria-hidden="true" />
                {t('channels.email.fields.find')}
              </Button>
            </div>
            <SavedNote text={found} />
            {microsoft ? <MicrosoftNote /> : <AppPasswordNote provider={provider} />}
          </div>
          <GuideLink href={DOCS.setup.emailChannel}>{t('channels.email.connect.guide')}</GuideLink>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <ImapFields
            prefix={prefix}
            draft={draft}
            errors={errors}
            patch={patch}
            password={
              <PasswordField
                id={fieldId(prefix, 'imap.password')}
                label={t('channels.email.fields.imapPassword')}
                value={draft.imap.password}
                error={errors['imap.password']}
                onChange={(value) => patch('imap.password', value)}
              />
            }
          />
          <AppPasswordNote provider={provider} />
        </div>
      ) : null}

      {step === 3 ? (
        <div className="flex flex-col gap-4">
          <SmtpServerFields prefix={prefix} draft={draft} errors={errors} patch={patch} />
          <CheckboxField
            id={fieldId(prefix, 'sameLogin')}
            label={t('channels.email.fields.sameLogin')}
            checked={draft.sameLogin}
            onCheckedChange={(same) =>
              setDraft((current) => ({
                ...current,
                sameLogin: same,
                // Start from the incoming login when outgoing mail gets its own.
                smtp:
                  !same && current.smtp.login === ''
                    ? { ...current.smtp, login: current.imap.login }
                    : current.smtp,
              }))
            }
          />
          {draft.sameLogin ? null : (
            <>
              <TextField
                id={fieldId(prefix, 'smtp.login')}
                label={t('channels.email.fields.smtpLogin')}
                hint={t('channels.email.fields.loginHint')}
                value={draft.smtp.login}
                maxLength={320}
                error={errors['smtp.login']}
                onChange={(event) => patch('smtp.login', event.target.value)}
                {...machineText}
              />
              <PasswordField
                id={fieldId(prefix, 'smtp.password')}
                label={t('channels.email.fields.smtpPassword')}
                value={draft.smtp.password}
                error={errors['smtp.password']}
                onChange={(value) => patch('smtp.password', value)}
              />
            </>
          )}
        </div>
      ) : null}

      {step === 4 ? (
        <div className="flex flex-col gap-4">
          <SwitchRow
            id={fieldId(prefix, 'aiAnswers')}
            label={t('channels.ai.label')}
            hint={t('channels.ai.hint')}
            checked={draft.aiAnswers}
            onChange={(on) => patch('aiAnswers', on)}
          />
          <SelectField
            id={fieldId(prefix, 'defaultTeamId')}
            label={t('channels.team.label')}
            value={draft.defaultTeamId}
            placeholder={t('channels.team.none')}
            options={teamOptions}
            error={errors.defaultTeamId}
            onChange={(event) => patch('defaultTeamId', event.target.value)}
          />
          <p className="text-sm text-text-secondary">{t('channels.email.connect.busyHint')}</p>
        </div>
      ) : null}

      {connect.isPending ? (
        <p role="status" className="text-sm font-medium text-text" data-testid="email-checking">
          {t('channels.email.connect.busy')}
        </p>
      ) : null}
      <ChannelProblem error={problem} />

      <DialogFooter>
        {step > 1 ? (
          <Button
            type="button"
            variant="secondary"
            disabled={connect.isPending}
            onClick={() => {
              setProblem(null);
              setStep((current) => Math.max(1, current - 1) as EmailStep);
            }}
          >
            <ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
            {t('channels.email.connect.back')}
          </Button>
        ) : null}
        {step < 4 ? (
          <Button type="submit" data-testid="email-next">
            {t('channels.email.connect.next')}
            <ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
          </Button>
        ) : (
          <Button type="submit" busy={connect.isPending} data-testid="email-connect-submit">
            {connect.isPending
              ? t('channels.email.connect.busy')
              : t('channels.email.connect.submit')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/** Connect email: four steps, then Chatwoot checks the mailbox and the channel is added. */
export function ConnectEmailDialog({
  brandId,
  teams,
  open,
  onOpenChange,
  onConnected,
  fallbackFocus,
}: {
  brandId: string;
  teams: readonly Team[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (channel: ChannelInbox) => void;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  return (
    <GuardedDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('channels.email.connect.title')}
      testId="connect-email-dialog"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      {({ onDirtyChange, onBusyChange, close }) => (
        <ConnectEmailForm
          brandId={brandId}
          teams={teams}
          onDirtyChange={onDirtyChange}
          onBusyChange={onBusyChange}
          onConnected={(channel) => {
            close();
            onConnected(channel);
          }}
        />
      )}
    </GuardedDialog>
  );
}

/** A section's password: kept as it is unless "Change password" opens a field for a new one. */
function ChangePassword({
  id,
  label,
  open,
  onOpenChange,
  value,
  onChange,
  error,
}: {
  id: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  const toggleId = `${id}-toggle`;
  if (!open) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-text">
          <span className="font-medium">{label}</span>
          {': '}
          <span className="text-text-secondary">{t('channels.email.settings.kept')}</span>
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          id={toggleId}
          aria-label={t('channels.email.settings.changeLabel', { field: label })}
          data-testid={`${id}-change`}
          onClick={() => onOpenChange(true)}
        >
          <KeyRoundIcon aria-hidden="true" />
          {t('channels.email.settings.change')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="w-full">
        <PasswordField id={id} label={label} value={value} error={error} onChange={onChange} />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        id={toggleId}
        data-testid={`${id}-keep`}
        onClick={() => onOpenChange(false)}
      >
        {t('channels.email.settings.keep')}
      </Button>
    </div>
  );
}

/** Email settings, loaded: one page with the address, incoming and outgoing mail. */
function EmailSettingsForm({
  brandId,
  channelId,
  settings,
  fixSignIn,
  onDirtyChange,
  onBusyChange,
  onSaved,
  onCancel,
}: {
  brandId: string;
  channelId: string;
  settings: EmailSettings;
  fixSignIn: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const message = useFieldMessage();
  const focusLater = useFocusLater();
  const update = useUpdateEmail(brandId, channelId);
  const prefix = `email-settings-${channelId}`;
  const initial = useMemo(() => draftFromSettings(settings), [settings]);
  const [draft, setDraft] = useState<EmailDraft>(initial);
  const [changing, setChanging] = useState({ imap: fixSignIn, smtp: false });
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<unknown>(null);

  // Fix sign-in: the incoming password is open and ready to type in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the form first shows
  useEffect(() => {
    if (fixSignIn) document.getElementById(fieldId(prefix, 'imap.password'))?.focus();
  }, []);

  const dirty = changing.imap || changing.smtp || JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(update.isPending), [update.isPending, onBusyChange]);

  const patch: Patch = (path, value) => {
    setDraft((current) => setEmailField(current, path, value));
    setErrors(({ [path]: _gone, ...rest }) => rest);
  };
  const toggle = (section: 'imap' | 'smtp', open: boolean) => {
    setChanging((current) => ({ ...current, [section]: open }));
    const path = `${section}.password`;
    setDraft((current) => setEmailField(current, path, ''));
    setErrors(({ [path]: _gone, ...rest }) => rest);
    // Focus the field that opened, or the button that took its place.
    focusLater(open ? fieldId(prefix, path) : `${fieldId(prefix, path)}-toggle`);
  };

  const save = async () => {
    setProblem(null);
    const paths = [
      'name',
      'address',
      'imap.address',
      'imap.port',
      'imap.login',
      ...(changing.imap ? ['imap.password'] : []),
      'smtp.address',
      'smtp.port',
      'smtp.login',
      ...(changing.smtp ? ['smtp.password'] : []),
    ];
    const bad = invalidEmailFields(draft, paths);
    if (bad.length > 0) {
      setErrors(Object.fromEntries(bad.map((path) => [path, message(path, true)])));
      focusLater(fieldId(prefix, bad[0] as string));
      return;
    }
    try {
      await update.mutateAsync(updateEmailBody(draft, changing));
      onSaved();
    } catch (error) {
      if (isCancelled(error)) return;
      setProblem(error);
      const fields = serverErrors(error);
      if (fields.length === 0) return;
      // A refused password: open its field so a new one can be typed.
      const reopen = {
        imap: changing.imap || fields.some((f) => f.path === 'imap.password'),
        smtp: changing.smtp || fields.some((f) => f.path === 'smtp.password'),
      };
      setChanging(reopen);
      setErrors(Object.fromEntries(fields.map((field) => [field.path, field.message])));
      const first = fields[0];
      if (first) focusLater(fieldId(prefix, first.path));
    }
  };

  const section = (id: string, title: string, children: ReactNode) => (
    <fieldset className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <legend id={id} className="px-1 text-sm font-semibold text-text">
        {title}
      </legend>
      {children}
    </fieldset>
  );

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      autoComplete="off"
      data-testid="email-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!update.isPending) void save();
      }}
    >
      {fixSignIn ? (
        <p className="text-sm text-text" data-testid="fix-sign-in-hint">
          {t('channels.email.fix.hint')}
        </p>
      ) : null}
      {section(
        `${prefix}-general`,
        t('channels.email.settings.general'),
        <>
          <TextField
            id={fieldId(prefix, 'name')}
            label={t('channels.email.fields.name')}
            value={draft.name}
            maxLength={100}
            error={errors.name}
            onChange={(event) => patch('name', event.target.value)}
          />
          <TextField
            id={fieldId(prefix, 'address')}
            label={t('channels.email.fields.address')}
            type="email"
            value={draft.address}
            maxLength={320}
            error={errors.address}
            onChange={(event) => patch('address', event.target.value)}
            {...machineText}
          />
        </>,
      )}
      {section(
        `${prefix}-incoming`,
        t('channels.email.settings.incoming'),
        <ImapFields
          prefix={prefix}
          draft={draft}
          errors={errors}
          patch={patch}
          password={
            <ChangePassword
              id={fieldId(prefix, 'imap.password')}
              label={t('channels.email.fields.imapPassword')}
              open={changing.imap}
              onOpenChange={(open) => toggle('imap', open)}
              value={draft.imap.password}
              onChange={(value) => patch('imap.password', value)}
              error={errors['imap.password']}
            />
          }
        />,
      )}
      {section(
        `${prefix}-outgoing`,
        t('channels.email.settings.outgoing'),
        <>
          <SmtpServerFields prefix={prefix} draft={draft} errors={errors} patch={patch} />
          <TextField
            id={fieldId(prefix, 'smtp.login')}
            label={t('channels.email.fields.smtpLogin')}
            hint={t('channels.email.fields.loginHint')}
            value={draft.smtp.login}
            maxLength={320}
            error={errors['smtp.login']}
            onChange={(event) => patch('smtp.login', event.target.value)}
            {...machineText}
          />
          <ChangePassword
            id={fieldId(prefix, 'smtp.password')}
            label={t('channels.email.fields.smtpPassword')}
            open={changing.smtp}
            onOpenChange={(open) => toggle('smtp', open)}
            value={draft.smtp.password}
            onChange={(value) => patch('smtp.password', value)}
            error={errors['smtp.password']}
          />
        </>,
      )}

      {update.isPending && (changing.imap || changing.smtp) ? (
        <p role="status" className="text-sm font-medium text-text">
          {t('channels.email.settings.busy')}
        </p>
      ) : null}
      <ChannelProblem error={problem} />

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={update.isPending} onClick={onCancel}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={update.isPending} data-testid="email-settings-save">
          {t('channels.email.settings.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The settings, once loaded; a failed load says so with a retry. */
function EmailSettingsBody(props: Omit<Parameters<typeof EmailSettingsForm>[0], 'settings'>) {
  const { t } = useTranslation();
  const settings = useEmailSettings(props.channelId);
  return (
    <QueryState query={settings} label={t('channels.email.settings.loading')}>
      {(data) => <EmailSettingsForm {...props} settings={data} />}
    </QueryState>
  );
}

/**
 * Email settings of one mailbox: its address, incoming and outgoing servers. Passwords are never
 * shown; one is sent only when changed. "Fix sign-in" opens it with the incoming password ready.
 */
export function EmailSettingsDialog({
  channel,
  brandId,
  open,
  onOpenChange,
  fixSignIn,
  onSaved,
  fallbackFocus,
}: {
  channel: ChannelInbox;
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fixSignIn: boolean;
  onSaved: () => void;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  return (
    <GuardedDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('channels.email.settings.title')}
      description={<bdi>{channel.name}</bdi>}
      testId="email-settings-dialog"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      {({ onDirtyChange, onBusyChange, close, requestClose }) => (
        <EmailSettingsBody
          brandId={brandId}
          channelId={channel.id}
          fixSignIn={fixSignIn}
          onDirtyChange={onDirtyChange}
          onBusyChange={onBusyChange}
          onSaved={() => {
            close();
            onSaved();
          }}
          onCancel={requestClose}
        />
      )}
    </GuardedDialog>
  );
}
