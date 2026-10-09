import type { FormAnswers, WidgetFormField } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { FormErrorSummary, focusFirstInvalid } from '@hamnivo/ui/components/form-error-summary';
import {
  type ChangeEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  answersOf,
  type FieldProblem,
  type FieldValues,
  isConsentRequired,
  labelOf,
  serverProblems,
  validateFields,
} from '../forms.js';
import { webHref } from './PrivacyLink.js';

const listed = (field: WidgetFormField) => field.kind === 'choice' || field.kind === 'department';

/** What each kind of answer asks the browser for: the right keyboard, autofill and direction. */
function inputOf(kind: WidgetFormField['kind']): InputHTMLAttributes<HTMLInputElement> {
  switch (kind) {
    case 'name':
      return { type: 'text', autoComplete: 'name', maxLength: 200, dir: 'auto' };
    // Addresses and numbers read left to right in every language.
    case 'email':
      return {
        type: 'email',
        autoComplete: 'email',
        inputMode: 'email',
        maxLength: 254,
        spellCheck: false,
        dir: 'ltr',
      };
    case 'phone':
      return { type: 'tel', autoComplete: 'tel', maxLength: 40, dir: 'ltr' };
    default:
      return { type: 'text', maxLength: 2000, dir: 'auto' };
  }
}

const problemKey = (field: WidgetFormField, problem: FieldProblem) =>
  problem === 'missing'
    ? listed(field)
      ? 'surface.form.missingChoice'
      : 'surface.form.missing'
    : problem === 'email'
      ? 'surface.form.email'
      : 'surface.form.invalid';

/** The element an error points to: the input, or a list's first answer. */
const targetOf = (prefix: string, field: WidgetFormField) =>
  listed(field) && field.options[0]
    ? `${prefix}-${field.id}-${field.options[0].id}`
    : `${prefix}-${field.id}`;

function Field(props: {
  field: WidgetFormField;
  id: string;
  value: string;
  problem: FieldProblem | undefined;
  locale: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const { field, id, problem } = props;
  const label = labelOf(field.label, props.locale);
  const errorId = `${id}-error`;
  const message = problem ? t(problemKey(field, problem)) : null;
  const required = field.required ? (
    <span className="font-normal text-text-muted">{` ${t('surface.form.required')}`}</span>
  ) : null;
  const error = message ? (
    <p id={errorId} className="text-sm text-danger">
      {message}
    </p>
  ) : null;
  if (listed(field)) {
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-text" dir="auto">
          {label}
          {required}
        </legend>
        {error}
        {field.options.map((option) => (
          <label
            key={option.id}
            htmlFor={`${id}-${option.id}`}
            className="flex min-h-11 items-center gap-2 text-sm text-text"
          >
            <input
              id={`${id}-${option.id}`}
              type="radio"
              name={id}
              value={option.id}
              checked={props.value === option.id}
              onChange={() => props.onChange(option.id)}
              aria-invalid={message ? true : undefined}
              aria-describedby={message ? errorId : undefined}
              className="size-5 shrink-0 accent-primary"
            />
            <span dir="auto">{labelOf(option.label, props.locale)}</span>
          </label>
        ))}
      </fieldset>
    );
  }
  const common = {
    id,
    value: props.value,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      props.onChange(event.target.value),
    'aria-invalid': message ? true : undefined,
    'aria-describedby': message ? errorId : undefined,
    'aria-required': field.required || undefined,
    className:
      'min-h-11 w-full min-w-0 rounded-xl border border-input bg-bg px-3 py-2 text-base text-text',
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text" dir="auto">
        {label}
        {required}
      </label>
      {error}
      {field.kind === 'question' ? (
        <textarea {...common} rows={3} maxLength={2000} dir="auto" />
      ) : (
        <input {...common} {...inputOf(field.kind)} />
      )}
    </div>
  );
}

/**
 * The brand's words the visitor agrees to before chatting (W27), with its privacy policy and a
 * box that is never ticked in advance.
 */
function ConsentBlock(props: {
  id: string;
  text: string;
  privacyPolicyUrl: string | null;
  checked: boolean;
  missing: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const href = webHref(props.privacyPolicyUrl);
  const describedBy = [`${props.id}-text`, props.missing ? `${props.id}-error` : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className="flex flex-col gap-2 rounded-xl bg-surface-sunken px-3 py-2"
      data-testid="consent"
    >
      <p id={`${props.id}-text`} className="text-sm text-text" dir="auto">
        {props.text}
      </p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="self-start text-sm text-link underline underline-offset-2"
        >
          {t('appearance.privacy')}
        </a>
      ) : null}
      {props.missing ? (
        <p id={`${props.id}-error`} className="text-sm text-danger">
          {t('surface.form.agreeMissing')}
        </p>
      ) : null}
      <label htmlFor={props.id} className="flex min-h-11 items-center gap-2 text-sm text-text">
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          onChange={(event) => props.onChange(event.target.checked)}
          aria-invalid={props.missing ? true : undefined}
          aria-describedby={describedBy}
          className="size-5 shrink-0 accent-primary"
        />
        <span>{t('surface.form.agree')}</span>
      </label>
    </div>
  );
}

/**
 * One of the brand's forms in the chat: its fields, the consent words when the visitor must agree
 * first, and a button that stays busy while it sends. Answers are checked before sending; the
 * problems are listed at the top and the first one gets focus. What the gateway refuses is shown
 * on its field; nothing typed is ever cleared.
 */
export function ChatForm(props: {
  /** Prefix for the fields' ids, unique on the page. */
  id: string;
  fields: readonly WidgetFormField[];
  initial?: FieldValues;
  locale: string;
  /** The words to agree to, when the visitor must agree first; null otherwise. */
  consent: { text: string; privacyPolicyUrl: string | null } | null;
  submit: string;
  /** Said when sending failed for another reason than the answers. */
  failed: string;
  onSubmit: (answers: FormAnswers, values: FieldValues) => Promise<void>;
  /** The gateway wants consent again (the words changed): the caller shows them anew. */
  onConsentRequired?: () => Promise<void>;
  onValues?: (values: FieldValues) => void;
  /** Another way out, next to the button. */
  secondary?: ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  const form = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<FieldValues>(props.initial ?? {});
  const [problems, setProblems] = useState<Record<string, FieldProblem>>({});
  const [agreed, setAgreed] = useState(false);
  const [agreeMissing, setAgreeMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const consentId = `${props.id}-consent`;

  const change = (fieldId: string, value: string) => {
    const next = { ...values, [fieldId]: value };
    setValues(next);
    props.onValues?.(next);
  };
  const focusFirst = () =>
    requestAnimationFrame(() => {
      if (form.current) focusFirstInvalid(form.current);
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const found = validateFields(props.fields, values);
    const missing = props.consent !== null && !agreed;
    setProblems(found);
    setAgreeMissing(missing);
    setFailed(false);
    if (Object.keys(found).length > 0 || missing) {
      focusFirst();
      return;
    }
    setBusy(true);
    try {
      await props.onSubmit(answersOf(props.fields, values), values);
    } catch (error) {
      if (isConsentRequired(error) && props.onConsentRequired) {
        setAgreed(false);
        await props.onConsentRequired();
        setAgreeMissing(true);
        focusFirst();
        return;
      }
      const refused = serverProblems(error, props.fields);
      if (Object.keys(refused).length > 0) {
        setProblems(refused);
        focusFirst();
      } else {
        setFailed(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    ...props.fields.flatMap((field) => {
      const problem = problems[field.id];
      return problem
        ? [
            {
              fieldId: targetOf(props.id, field),
              message: t('surface.form.summaryItem', {
                label: labelOf(field.label, props.locale),
                message: t(problemKey(field, problem)),
              }),
            },
          ]
        : [];
    }),
    ...(agreeMissing && props.consent
      ? [{ fieldId: consentId, message: t('surface.form.agreeMissing') }]
      : []),
  ];

  return (
    <form
      ref={form}
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => void submit(event)}
      data-testid={props.testId}
    >
      <FormErrorSummary
        title={t('surface.form.errorsTitle')}
        errors={summary}
        focusOnMount={false}
        className="p-3"
      />
      {props.fields.map((field) => (
        <Field
          key={field.id}
          field={field}
          id={`${props.id}-${field.id}`}
          value={values[field.id] ?? ''}
          problem={problems[field.id]}
          locale={props.locale}
          onChange={(value) => change(field.id, value)}
        />
      ))}
      {props.consent ? (
        <ConsentBlock
          id={consentId}
          text={props.consent.text}
          privacyPolicyUrl={props.consent.privacyPolicyUrl}
          checked={agreed}
          missing={agreeMissing}
          onChange={setAgreed}
        />
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-danger">
          {props.failed}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className="min-h-11" busy={busy}>
          {props.submit}
        </Button>
        {props.secondary}
      </div>
    </form>
  );
}
