import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@hamnivo/ui/components/field';
import { Input } from '@hamnivo/ui/components/input';
import { useAnnouncer } from '@hamnivo/ui/components/live-region';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  InfoIcon,
  RefreshCwIcon,
  WebhookIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog, DialogFooter } from '../../components/AppDialog';
import { TextField } from '../../components/Fields';
import { GuideLink } from '../../components/GuideLink';
import { QueryState } from '../../components/States';
import {
  type ChannelInbox,
  connectTelegramBody,
  connectWhatsappBody,
  emptyTelegramDraft,
  emptyWhatsappDraft,
  invalidTelegramFields,
  invalidWhatsappFields,
  type TelegramDraft,
  useConnectTelegram,
  useConnectWhatsapp,
  useWhatsappSetup,
  WHATSAPP_STEPS,
  type WhatsappDraft,
  type WhatsappSetup,
  type WhatsappStep,
  whatsappStepOf,
} from '../../lib/channels';
import { DOCS } from '../../lib/docs';
import { isCancelled } from '../../lib/reauth';
import type { Team } from '../../lib/types';
import {
  AnsweringFields,
  fieldId,
  GuardedDialog,
  machineText,
  PasswordField,
  StepHeading,
  serverErrors,
  useFocusLater,
} from './ChannelForm';
import { ChannelProblem, SavedNote } from './ChannelNotes';

/** Where Meta explains the Cloud API's numbers, ids and permanent access tokens. */
export const META_GUIDE_URL = 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started';
/** Where Telegram explains @BotFather and bot tokens. */
export const BOTFATHER_GUIDE_URL = 'https://core.telegram.org/bots/features#botfather';

type Errors = Record<string, string>;

/** Where to find what a form asks for, with a link to the provider's own guide. */
function HelpNote({
  title,
  text,
  href,
  link,
  testId,
}: {
  title: string;
  text: string;
  href: string;
  link: string;
  testId: string;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3 text-sm"
      data-testid={testId}
    >
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-text">{title}</p>
        <p className="text-text">{text}</p>
        <GuideLink href={href}>{link}</GuideLink>
      </div>
    </div>
  );
}

/**
 * A value to paste somewhere else: read-only, left to right, with Copy. Copied is said next to the
 * button and to screen readers; when the browser refuses, the text is selected to copy by hand.
 */
function CopyRow({ id, label, value }: { id: string; label: string; value: string }) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
      announce(t('app.copied'));
    } catch {
      setState('failed');
      announce(t('access.copyFailed'), 'assertive');
      const input = document.getElementById(id) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    }
  };
  return (
    <Field className="gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          readOnly
          dir="ltr"
          className="flex-1 font-mono"
          onFocus={(event) => event.currentTarget.select()}
          data-testid={`${id}-value`}
        />
        <Button
          type="button"
          variant="secondary"
          aria-label={t('channels.whatsapp.setup.copyLabel', { field: label })}
          data-testid={`${id}-copy`}
          onClick={() => void copy()}
        >
          <CopyIcon aria-hidden="true" />
          {t('channels.whatsapp.setup.copy')}
        </Button>
      </div>
      {state === 'copied' ? (
        <p className="flex items-center gap-1.5 text-sm text-success" data-testid={`${id}-copied`}>
          <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          {t('app.copied')}
        </p>
      ) : state === 'failed' ? (
        <FieldDescription className="text-danger">{t('access.copyFailed')}</FieldDescription>
      ) : null}
    </Field>
  );
}

/** What to paste into Meta's webhook set-up: the callback address and the verify token. */
export function WhatsappSetupPanel({ setup, prefix }: { setup: WhatsappSetup; prefix: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4" data-testid="whatsapp-setup">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-muted p-3 text-sm">
        <WebhookIcon className="mt-0.5 size-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <p className="text-text" data-testid="whatsapp-setup-steps">
          {t('channels.whatsapp.setup.instructions')}
        </p>
      </div>
      <CopyRow
        id={`${prefix}-callback`}
        label={t('channels.whatsapp.setup.callbackUrl')}
        value={setup.callbackUrl}
      />
      {setup.verifyToken ? (
        <CopyRow
          id={`${prefix}-verify`}
          label={t('channels.whatsapp.setup.verifyToken')}
          value={setup.verifyToken}
        />
      ) : (
        <p className="text-sm text-text" data-testid="whatsapp-no-token">
          {t('channels.whatsapp.setup.noToken')}
        </p>
      )}
    </div>
  );
}

const WHATSAPP_STEP_KEYS = { 1: 'number', 2: 'answering', 3: 'webhook' } as const;

/**
 * The steps of Connect WhatsApp: the number, who answers, then (once Chatwoot has checked the
 * token with Meta and connected it) what to paste into Meta's webhook set-up. The access token
 * lives only in this form's state: it is wiped once sent, and closing the dialog forgets it all.
 */
function ConnectWhatsappForm({
  brandId,
  teams,
  onDirtyChange,
  onBusyChange,
  onConnected,
  onDone,
}: {
  brandId: string;
  teams: readonly Team[];
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onConnected: (channel: ChannelInbox) => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const announce = useAnnouncer();
  const focusLater = useFocusLater();
  const connect = useConnectWhatsapp(brandId);
  const prefix = 'whatsapp-connect';
  const initial = useMemo(() => emptyWhatsappDraft(t('channels.whatsapp.fields.nameDefault')), [t]);
  const [draft, setDraft] = useState<WhatsappDraft>(initial);
  const [step, setStep] = useState<WhatsappStep>(1);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<unknown>(null);
  const [setup, setSetup] = useState<{ channel: ChannelInbox; setup: WhatsappSetup } | null>(null);

  const dirty = !setup && JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(connect.isPending), [connect.isPending, onBusyChange]);

  const message = (path: string) =>
    path === 'name'
      ? t('channels.email.errors.name')
      : t(`channels.whatsapp.errors.${path as 'phoneNumber'}`);

  const patch = (path: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [path]: value }));
    setErrors(({ [path]: _gone, ...rest }) => rest);
  };

  /** Checks the number's fields; says what is missing next to each and focuses the first. */
  const check = (): boolean => {
    const bad = invalidWhatsappFields(draft);
    if (bad.length === 0) return true;
    setErrors((current) => ({
      ...current,
      ...Object.fromEntries(bad.map((path) => [path, message(path)])),
    }));
    setStep(1);
    focusLater(fieldId(prefix, bad[0] as string));
    return false;
  };

  const submit = async () => {
    setProblem(null);
    if (!check()) return;
    try {
      const made = await connect.mutateAsync(connectWhatsappBody(draft));
      // The token went to Chatwoot; nothing of it stays here.
      setDraft((current) => ({ ...current, accessToken: '' }));
      setSetup(made);
      setStep(3);
      onConnected(made.channel);
      announce(t('channels.whatsapp.connect.connected'));
    } catch (error) {
      if (isCancelled(error)) return;
      setProblem(error);
      const fields = serverErrors(error);
      if (fields.length === 0) return;
      setErrors(Object.fromEntries(fields.map((field) => [field.path, field.message])));
      const first = fields.find((field) => whatsappStepOf(field.path) !== null);
      if (first) {
        setStep(whatsappStepOf(first.path) as WhatsappStep);
        focusLater(fieldId(prefix, first.path));
      }
    }
  };

  const stepKey = WHATSAPP_STEP_KEYS[step];

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      autoComplete="off"
      data-testid="connect-whatsapp-form"
      data-step={step}
      onSubmit={(event) => {
        event.preventDefault();
        if (connect.isPending) return;
        if (step === 1) {
          setProblem(null);
          if (check()) setStep(2);
        } else if (step === 2) void submit();
        else onDone();
      }}
    >
      <StepHeading
        step={step}
        total={WHATSAPP_STEPS.length}
        title={t(`channels.whatsapp.connect.steps.${stepKey}`)}
        intro={t(`channels.whatsapp.connect.intros.${stepKey}`)}
        testId="whatsapp-step"
      />

      {step === 1 ? (
        <div className="flex flex-col gap-4">
          <HelpNote
            title={t('channels.whatsapp.help.title')}
            text={t('channels.whatsapp.help.text')}
            href={META_GUIDE_URL}
            link={t('channels.whatsapp.help.link')}
            testId="whatsapp-help"
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
          <TextField
            id={fieldId(prefix, 'phoneNumber')}
            label={t('channels.whatsapp.fields.phoneNumber')}
            hint={t('channels.whatsapp.fields.phoneNumberHint')}
            type="tel"
            inputMode="tel"
            value={draft.phoneNumber}
            maxLength={30}
            error={errors.phoneNumber}
            onChange={(event) => patch('phoneNumber', event.target.value)}
            {...machineText}
          />
          <TextField
            id={fieldId(prefix, 'phoneNumberId')}
            label={t('channels.whatsapp.fields.phoneNumberId')}
            inputMode="numeric"
            value={draft.phoneNumberId}
            maxLength={30}
            error={errors.phoneNumberId}
            onChange={(event) => patch('phoneNumberId', event.target.value)}
            {...machineText}
          />
          <TextField
            id={fieldId(prefix, 'businessAccountId')}
            label={t('channels.whatsapp.fields.businessAccountId')}
            inputMode="numeric"
            value={draft.businessAccountId}
            maxLength={30}
            error={errors.businessAccountId}
            onChange={(event) => patch('businessAccountId', event.target.value)}
            {...machineText}
          />
          <PasswordField
            id={fieldId(prefix, 'accessToken')}
            label={t('channels.whatsapp.fields.accessToken')}
            hint={t('channels.whatsapp.fields.accessTokenHint')}
            value={draft.accessToken}
            maxLength={1000}
            error={errors.accessToken}
            onChange={(value) => patch('accessToken', value)}
          />
          <GuideLink href={DOCS.setup.whatsappChannel}>
            {t('channels.whatsapp.connect.guide')}
          </GuideLink>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="flex flex-col gap-4">
          <AnsweringFields
            prefix={prefix}
            aiAnswers={draft.aiAnswers}
            defaultTeamId={draft.defaultTeamId}
            teams={teams}
            error={errors.defaultTeamId}
            onChange={patch}
          />
          <p className="text-sm text-text-secondary">{t('channels.whatsapp.connect.busyHint')}</p>
        </div>
      ) : null}

      {step === 3 && setup ? (
        <div className="flex flex-col gap-4">
          <SavedNote text={t('channels.whatsapp.connect.connected')} />
          <WhatsappSetupPanel setup={setup.setup} prefix={prefix} />
        </div>
      ) : null}

      {connect.isPending ? (
        <p role="status" className="text-sm font-medium text-text" data-testid="whatsapp-checking">
          {t('channels.whatsapp.connect.busy')}
        </p>
      ) : null}
      <ChannelProblem error={problem} />

      <DialogFooter>
        {step === 2 ? (
          <Button
            type="button"
            variant="secondary"
            disabled={connect.isPending}
            onClick={() => {
              setProblem(null);
              setStep(1);
            }}
          >
            <ArrowLeftIcon className="rtl:rotate-180" aria-hidden="true" />
            {t('channels.email.connect.back')}
          </Button>
        ) : null}
        {step === 1 ? (
          <Button type="submit" data-testid="whatsapp-next">
            {t('channels.email.connect.next')}
            <ArrowRightIcon className="rtl:rotate-180" aria-hidden="true" />
          </Button>
        ) : step === 2 ? (
          <Button type="submit" busy={connect.isPending} data-testid="whatsapp-connect-submit">
            {connect.isPending
              ? t('channels.whatsapp.connect.busy')
              : t('channels.whatsapp.connect.submit')}
          </Button>
        ) : (
          <Button type="submit" data-testid="whatsapp-done">
            {t('channels.whatsapp.setup.done')}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * Connect WhatsApp: the number, who answers, then Meta's webhook set-up in the same dialog. The
 * page hears about the new channel when the dialog closes (Done, Close or Escape).
 */
export function ConnectWhatsappDialog({
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
  const made = useRef<ChannelInbox | null>(null);
  return (
    <GuardedDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && made.current) {
          const channel = made.current;
          made.current = null;
          onConnected(channel);
        }
      }}
      title={t('channels.whatsapp.connect.title')}
      testId="connect-whatsapp-dialog"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      {({ onDirtyChange, onBusyChange, close }) => (
        <ConnectWhatsappForm
          brandId={brandId}
          teams={teams}
          onDirtyChange={onDirtyChange}
          onBusyChange={onBusyChange}
          onConnected={(channel) => {
            made.current = channel;
          }}
          onDone={close}
        />
      )}
    </GuardedDialog>
  );
}

/** The set-up as Chatwoot has it now; a failed read shows the gateway's words and a retry. */
function WhatsappSetupBody({ channelId, onDone }: { channelId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const setup = useWhatsappSetup(channelId);
  const footer = (
    <DialogFooter>
      <Button type="button" onClick={onDone} data-testid="whatsapp-setup-done">
        {t('channels.whatsapp.setup.done')}
      </Button>
    </DialogFooter>
  );
  if (setup.error && setup.data === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <ChannelProblem error={setup.error} />
        <div>
          <Button
            type="button"
            variant="secondary"
            busy={setup.isRefetching}
            onClick={() => void setup.refetch()}
          >
            <RefreshCwIcon aria-hidden="true" />
            {t('app.retry')}
          </Button>
        </div>
        {footer}
      </div>
    );
  }
  return (
    <QueryState query={setup} label={t('channels.whatsapp.setup.loading')}>
      {(data) => (
        <div className="flex flex-col gap-5">
          <WhatsappSetupPanel setup={data} prefix={`whatsapp-setup-${channelId}`} />
          {footer}
        </div>
      )}
    </QueryState>
  );
}

/** Meta set-up of a WhatsApp channel: what to paste into Meta's webhook settings, again. */
export function WhatsappSetupDialog({
  channel,
  open,
  onOpenChange,
  fallbackFocus,
}: {
  channel: ChannelInbox;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fallbackFocus?: () => HTMLElement | null;
}) {
  const { t } = useTranslation();
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('channels.whatsapp.setup.title')}
      description={<bdi>{channel.name}</bdi>}
      testId="whatsapp-setup-dialog"
      className="sm:max-w-xl"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      {open ? (
        <WhatsappSetupBody channelId={channel.id} onDone={() => onOpenChange(false)} />
      ) : null}
    </AppDialog>
  );
}

/**
 * Connect Telegram: the bot's token from @BotFather and who answers. Chatwoot asks Telegram for
 * the bot before it connects it; the token lives only in this form's state.
 */
function ConnectTelegramForm({
  brandId,
  teams,
  onDirtyChange,
  onBusyChange,
  onConnected,
  onCancel,
}: {
  brandId: string;
  teams: readonly Team[];
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onConnected: (channel: ChannelInbox) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const focusLater = useFocusLater();
  const connect = useConnectTelegram(brandId);
  const prefix = 'telegram-connect';
  const initial = useMemo(() => emptyTelegramDraft(t('channels.telegram.fields.nameDefault')), [t]);
  const [draft, setDraft] = useState<TelegramDraft>(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [problem, setProblem] = useState<unknown>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(connect.isPending), [connect.isPending, onBusyChange]);

  const patch = (path: string, value: string | boolean) => {
    setDraft((current) => ({ ...current, [path]: value }));
    setErrors(({ [path]: _gone, ...rest }) => rest);
  };

  const submit = async () => {
    setProblem(null);
    const bad = invalidTelegramFields(draft);
    if (bad.length > 0) {
      setErrors(
        Object.fromEntries(
          bad.map((path) => [
            path,
            path === 'name'
              ? t('channels.email.errors.name')
              : t('channels.telegram.errors.botToken'),
          ]),
        ),
      );
      focusLater(fieldId(prefix, bad[0] as string));
      return;
    }
    try {
      const channel = await connect.mutateAsync(connectTelegramBody(draft));
      onConnected(channel);
    } catch (error) {
      if (isCancelled(error)) return;
      setProblem(error);
      const fields = serverErrors(error);
      if (fields.length === 0) return;
      setErrors(Object.fromEntries(fields.map((field) => [field.path, field.message])));
      const first = fields.find((field) =>
        ['name', 'botToken', 'defaultTeamId'].includes(field.path),
      );
      if (first) focusLater(fieldId(prefix, first.path));
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      autoComplete="off"
      data-testid="connect-telegram-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!connect.isPending) void submit();
      }}
    >
      <p className="text-sm text-text-secondary">{t('channels.telegram.connect.intro')}</p>
      <HelpNote
        title={t('channels.telegram.help.title')}
        text={t('channels.telegram.help.text')}
        href={BOTFATHER_GUIDE_URL}
        link={t('channels.telegram.help.link')}
        testId="telegram-help"
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
      <PasswordField
        id={fieldId(prefix, 'botToken')}
        label={t('channels.telegram.fields.botToken')}
        hint={t('channels.telegram.fields.botTokenHint')}
        value={draft.botToken}
        maxLength={200}
        error={errors.botToken}
        onChange={(value) => patch('botToken', value)}
      />
      <GuideLink href={DOCS.setup.telegramChannel}>
        {t('channels.telegram.connect.guide')}
      </GuideLink>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-md font-semibold text-text">
          {t('channels.email.connect.steps.answering')}
        </legend>
        <AnsweringFields
          prefix={prefix}
          aiAnswers={draft.aiAnswers}
          defaultTeamId={draft.defaultTeamId}
          teams={teams}
          error={errors.defaultTeamId}
          onChange={patch}
        />
      </fieldset>

      {connect.isPending ? (
        <p role="status" className="text-sm font-medium text-text" data-testid="telegram-checking">
          {t('channels.telegram.connect.busy')}
        </p>
      ) : null}
      <ChannelProblem error={problem} />

      <DialogFooter>
        <Button type="button" variant="secondary" disabled={connect.isPending} onClick={onCancel}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" busy={connect.isPending} data-testid="telegram-connect-submit">
          {connect.isPending
            ? t('channels.telegram.connect.busy')
            : t('channels.telegram.connect.submit')}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function ConnectTelegramDialog({
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
      title={t('channels.telegram.connect.title')}
      testId="connect-telegram-dialog"
      {...(fallbackFocus ? { fallbackFocus } : {})}
    >
      {({ onDirtyChange, onBusyChange, close, requestClose }) => (
        <ConnectTelegramForm
          brandId={brandId}
          teams={teams}
          onDirtyChange={onDirtyChange}
          onBusyChange={onBusyChange}
          onCancel={requestClose}
          onConnected={(channel) => {
            close();
            onConnected(channel);
          }}
        />
      )}
    </GuardedDialog>
  );
}
