import { HamnivoApiError } from '@hamnivo/client';
import type { FormAnswers, WidgetConfig, WidgetFormField, WidgetSession } from '@hamnivo/contracts';

/**
 * The brand's forms in the chat: the pre-chat form (W26), the contact form while nobody can answer
 * (W11) and consent before chatting (W27). Checked here first so mistakes are named at once; the
 * gateway checks the same answers again.
 */

/** What the visitor typed or picked, by field id (a list answer is the option's id). */
export type FieldValues = Record<string, string>;

/** Why an answer can't be sent: missing, not an email address, or refused by the gateway. */
export type FieldProblem = 'missing' | 'email' | 'invalid';

/** A label in the visitor's language; the gateway fills every language, English first. */
export function labelOf(label: Record<string, string>, locale: string): string {
  return label[locale] || label.en || Object.values(label).find(Boolean) || '';
}

/** An address with something before and after the @, and a dot in the domain. */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const listed = (field: WidgetFormField) => field.kind === 'choice' || field.kind === 'department';

/** The problems with the answers, by field id; empty when they can be sent. */
export function validateFields(
  fields: readonly WidgetFormField[],
  values: FieldValues,
): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  for (const field of fields) {
    const value = (values[field.id] ?? '').trim();
    if (!value) {
      if (field.required) problems[field.id] = 'missing';
      continue;
    }
    if (field.kind === 'email' && !isEmail(value)) problems[field.id] = 'email';
    if (listed(field) && !field.options.some((option) => option.id === value)) {
      problems[field.id] = 'invalid';
    }
  }
  return problems;
}

/** The answers to send: the form's own fields only, trimmed, and only those given. */
export function answersOf(fields: readonly WidgetFormField[], values: FieldValues): FormAnswers {
  const answers: FormAnswers = {};
  for (const field of fields) {
    const value = (values[field.id] ?? '').trim();
    if (value) answers[field.id] = value;
  }
  return answers;
}

/**
 * The fields the gateway refused (VALIDATION_FAILED names them by path, such as `prechat.email`
 * or `answers.email`). Paths that are not one of the form's fields are left out.
 */
export function serverProblems(
  error: unknown,
  fields: readonly WidgetFormField[],
): Record<string, FieldProblem> {
  const problems: Record<string, FieldProblem> = {};
  if (!(error instanceof HamnivoApiError) || error.code !== 'VALIDATION_FAILED') return problems;
  const listedFields = Array.isArray(error.problem.fields) ? error.problem.fields : [];
  for (const entry of listedFields) {
    const path = String((entry as { path?: unknown })?.path ?? '');
    const id = path.replace(/^(prechat|answers)\./, '');
    const field = fields.find((f) => f.id === id);
    if (field) problems[field.id] = field.kind === 'email' ? 'email' : 'invalid';
  }
  return problems;
}

/** The gateway asks for consent first: the brand asks for it and it is missing or out of date. */
export const isConsentRequired = (error: unknown) =>
  error instanceof HamnivoApiError && error.code === 'CONSENT_REQUIRED';

/** This visitor must agree before a chat starts, and has not yet (W27). */
export function consentNeeded(config: Pick<WidgetConfig, 'consent'>): boolean {
  return Boolean(config.consent?.required && !config.consent.given);
}

/**
 * The pre-chat form is asked before the first conversation (W26), unless the website signed the
 * customer in and the brand lets such customers straight in.
 */
export function prechatNeeded(session: Pick<WidgetSession, 'config' | 'principal'>): boolean {
  const form = session.config.forms?.prechat;
  if (!form?.enabled || form.fields.length === 0) return false;
  return !(form.skipVerified && session.principal.verified);
}

/** The form's first values: a question field holds what the visitor already wrote. */
export function prefill(fields: readonly WidgetFormField[], pending: string): FieldValues {
  const question = fields.find((f) => f.kind === 'question');
  return question && pending ? { [question.id]: pending } : {};
}

/**
 * The conversation's first message: the question as finally written when the form asks one
 * (it started as the visitor's message), otherwise the message the visitor wrote.
 */
export function firstMessageOf(
  fields: readonly WidgetFormField[],
  values: FieldValues,
  pending: string,
): string | undefined {
  const question = fields.find((f) => f.kind === 'question');
  const asked = question ? (values[question.id] ?? '').trim() : '';
  return asked || pending.trim() || undefined;
}
