import { Button } from '@hamnivo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@hamnivo/ui/components/field';
import { Input } from '@hamnivo/ui/components/input';
import { Label } from '@hamnivo/ui/components/label';
import { Switch } from '@hamnivo/ui/components/switch';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppDialog } from '../../components/AppDialog';
import { describedBy, SelectField } from '../../components/Fields';
import { isApiError } from '../../lib/api';
import type { Team } from '../../lib/types';
import { DiscardChangesDialog, LeaveGuard } from '../settings/DiscardChangesDialog';

/**
 * What the Connect and settings dialogs of every channel share: secret fields, the answering
 * fields, step headings and a dialog that asks before throwing typed input away.
 */

/** The id of a field's control, from the gateway's name for the field (`imap.password`…). */
export const fieldId = (prefix: string, path: string) => `${prefix}-${path.replace('.', '-')}`;

/** The gateway's field messages (Chatwoot refused the channel), by field. */
export const serverErrors = (error: unknown): { path: string; message: string }[] =>
  isApiError(error, 'VALIDATION_FAILED') ? error.fields : [];

/**
 * A password or token, hidden unless shown. It reads left to right in every language and is never
 * filled by the browser from what it saved.
 */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  maxLength = 500,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  hint?: ReactNode;
  maxLength?: number;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex gap-2">
        <Input
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className="flex-1"
          dir="ltr"
          maxLength={maxLength}
        />
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label={t('channels.email.fields.show', { field: label })}
          aria-pressed={visible}
          aria-controls={id}
          title={
            visible
              ? t('channels.email.fields.hide', { field: label })
              : t('channels.email.fields.show', { field: label })
          }
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
        </Button>
      </div>
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

/** A host name, port, login, number or id: typed left to right, never corrected or capitalised. */
export const machineText = {
  dir: 'ltr',
  spellCheck: false,
  autoCapitalize: 'none',
  autoCorrect: 'off',
  autoComplete: 'off',
} as const;

/** A switch with its label and hint on one bordered row (as on the channel card). */
export function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-sm text-text-secondary">
          {hint}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        aria-describedby={`${id}-hint`}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** Who answers a new channel: the AI switch and the team, as on the channel card. */
export function AnsweringFields({
  prefix,
  aiAnswers,
  defaultTeamId,
  teams,
  error,
  onChange,
}: {
  prefix: string;
  aiAnswers: boolean;
  defaultTeamId: string;
  teams: readonly Team[];
  error?: string | undefined;
  onChange: (path: 'aiAnswers' | 'defaultTeamId', value: string | boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <SwitchRow
        id={fieldId(prefix, 'aiAnswers')}
        label={t('channels.ai.label')}
        hint={t('channels.ai.hint')}
        checked={aiAnswers}
        onChange={(on) => onChange('aiAnswers', on)}
      />
      <SelectField
        id={fieldId(prefix, 'defaultTeamId')}
        label={t('channels.team.label')}
        value={defaultTeamId}
        placeholder={t('channels.team.none')}
        options={teams.map((team) => ({ value: team.id, label: team.name }))}
        error={error}
        onChange={(event) => onChange('defaultTeamId', event.target.value)}
      />
    </>
  );
}

/** The step's place and title; it takes focus when the step changes, for screen readers. */
export function StepHeading({
  step,
  total,
  title,
  intro,
  testId = 'email-step',
}: {
  step: number;
  total: number;
  title: string;
  intro: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves when the step changes
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
  }, [step]);
  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-text-secondary" data-testid={testId}>
        {t('channels.email.connect.step', { step, total })}
      </p>
      <h3 ref={ref} tabIndex={-1} className="text-md font-semibold text-text outline-none">
        {title}
      </h3>
      <p className="text-sm text-text-secondary">{intro}</p>
    </div>
  );
}

/** Focuses a field once it is on screen (after a step change it is rendered first). */
export function useFocusLater(): (id: string) => void {
  const [target, setTarget] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!target) return;
    const element = document.getElementById(target.id);
    element?.focus();
    setTarget(null);
  }, [target]);
  return (id: string) => setTarget({ id });
}

/**
 * A dialog whose content asks before closing with input that is not saved. The content says
 * whether it has any (and whether it is busy, when it cannot be closed); leaving the page asks too.
 */
export function GuardedDialog({
  open,
  onOpenChange,
  title,
  description,
  testId,
  fallbackFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  testId: string;
  fallbackFocus?: () => HTMLElement | null;
  children: (guard: {
    onDirtyChange: (dirty: boolean) => void;
    onBusyChange: (busy: boolean) => void;
    /** Closes now (after a save). */
    close: () => void;
    /** Closes, asking first when there is input that is not saved. */
    requestClose: () => void;
  }) => ReactNode;
}) {
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = () => {
    setDirty(false);
    setBusy(false);
    setAsking(false);
    onOpenChange(false);
  };
  const requestClose = () => {
    if (busy) return;
    if (dirty) setAsking(true);
    else close();
  };
  return (
    <>
      <AppDialog
        open={open}
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
        title={title}
        {...(description ? { description } : {})}
        testId={testId}
        className="sm:max-w-xl"
        {...(fallbackFocus ? { fallbackFocus } : {})}
      >
        {children({ onDirtyChange: setDirty, onBusyChange: setBusy, close, requestClose })}
      </AppDialog>
      <DiscardChangesDialog open={asking} onKeep={() => setAsking(false)} onDiscard={close} />
      <LeaveGuard dirty={open && dirty} />
    </>
  );
}
