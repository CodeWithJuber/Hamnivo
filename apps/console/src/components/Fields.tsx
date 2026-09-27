import { Checkbox } from '@hamnivo/ui/components/checkbox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@hamnivo/ui/components/field';
import { Input } from '@hamnivo/ui/components/input';
import { Label } from '@hamnivo/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@hamnivo/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@hamnivo/ui/components/radio-group';
import { Textarea } from '@hamnivo/ui/components/textarea';
import type * as React from 'react';

/** ids of the hint and error that describe a control, for aria-describedby. */
export function describedBy(id: string, hint?: unknown, error?: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

/**
 * Typed text keeps its own direction, so English typed on an Arabic page (or the reverse) reads the
 * right way round. An empty field still starts from the page's side; numbers, dates and fields
 * with a set direction are left alone.
 */
function textDirection(props: {
  dir?: string | undefined;
  value?: unknown;
  inputMode?: string | undefined;
  type?: string | undefined;
}): string | undefined {
  if (props.dir !== undefined) return props.dir;
  if (props.inputMode === 'numeric' || props.inputMode === 'decimal') return undefined;
  if (props.type !== undefined && props.type !== 'text' && props.type !== 'search')
    return undefined;
  return typeof props.value === 'string' && props.value !== '' ? 'auto' : undefined;
}

interface FieldChrome {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string | undefined;
  /** Shown after the label, e.g. "Optional". */
  labelNote?: string;
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  labelNote,
  children,
}: FieldChrome & { children: React.ReactNode }) {
  return (
    <Field data-invalid={error ? true : undefined} className="gap-2">
      <FieldLabel htmlFor={id}>
        {label}
        {labelNote ? <span className="font-normal text-text-muted">({labelNote})</span> : null}
      </FieldLabel>
      {children}
      {hint ? <FieldDescription id={`${id}-hint`}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export function TextField({
  id,
  label,
  hint,
  error,
  labelNote,
  ...input
}: FieldChrome & Omit<React.ComponentProps<'input'>, 'id'>) {
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      {...(labelNote ? { labelNote } : {})}
    >
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...input}
        dir={textDirection(input)}
      />
    </FieldFrame>
  );
}

export function TextareaField({
  id,
  label,
  hint,
  error,
  labelNote,
  ...textarea
}: FieldChrome & Omit<React.ComponentProps<'textarea'>, 'id'>) {
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      {...(labelNote ? { labelNote } : {})}
    >
      <Textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...textarea}
        dir={textDirection(textarea)}
      />
    </FieldFrame>
  );
}

export interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectField({
  id,
  label,
  hint,
  error,
  labelNote,
  options,
  placeholder,
  className,
  ...select
}: FieldChrome &
  Omit<React.ComponentProps<'select'>, 'id' | 'size'> & {
    options: Option[];
    placeholder?: string;
  }) {
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      {...(labelNote ? { labelNote } : {})}
    >
      <NativeSelect
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={className ?? 'w-full'}
        {...select}
      >
        {placeholder !== undefined ? (
          <NativeSelectOption value="">{placeholder}</NativeSelectOption>
        ) : null}
        {options.map((option) => (
          <NativeSelectOption key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FieldFrame>
  );
}

export function CheckboxField({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        disabled={disabled}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="leading-snug">
          {label}
        </Label>
        {hint ? (
          <p id={`${id}-hint`} className="text-sm text-text-secondary">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface Choice {
  value: string;
  label: string;
  hint?: string;
}

/** A labelled group of radio buttons; arrow keys move between choices (and follow RTL). */
export function ChoiceField({
  id,
  legend,
  hint,
  error,
  value,
  onValueChange,
  choices,
  disabled,
  columns = false,
}: {
  id: string;
  legend: string;
  hint?: React.ReactNode;
  error?: string | undefined;
  value: string;
  onValueChange: (value: string) => void;
  choices: Choice[];
  disabled?: boolean;
  columns?: boolean;
}) {
  return (
    <FieldSet className="gap-3">
      <FieldLegend id={`${id}-legend`} variant="label" className="mb-0">
        {legend}
      </FieldLegend>
      {hint ? (
        <FieldDescription id={`${id}-hint`} className="mt-0">
          {hint}
        </FieldDescription>
      ) : null}
      <RadioGroup
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        aria-labelledby={`${id}-legend`}
        aria-describedby={describedBy(id, hint, error)}
        className={columns ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-3'}
      >
        {choices.map((choice) => (
          // The whole card selects the choice; the radio's name is only the choice label.
          <label
            key={choice.value}
            htmlFor={`${id}-${choice.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3 has-data-[state=checked]:border-text has-data-[state=checked]:bg-surface-muted"
          >
            <RadioGroupItem
              id={`${id}-${choice.value}`}
              value={choice.value}
              className="mt-0.5"
              aria-labelledby={`${id}-${choice.value}-label`}
              aria-describedby={choice.hint ? `${id}-${choice.value}-hint` : undefined}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={`${id}-${choice.value}-label`} className="text-sm font-medium text-text">
                {choice.label}
              </span>
              {choice.hint ? (
                <span id={`${id}-${choice.value}-hint`} className="text-sm text-text-secondary">
                  {choice.hint}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </RadioGroup>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </FieldSet>
  );
}
