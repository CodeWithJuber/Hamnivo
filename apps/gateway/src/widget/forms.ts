import type { ChatFormField, FormAnswers } from '@hamnivo/contracts';
import { plausibleEmail, plausiblePhone } from '@hamnivo/domain';
import { AppError } from '../common/app-error.js';

/** The longest answer each kind takes; the contract caps every answer at 2000. */
const MAX_LENGTH: Record<ChatFormField['kind'], number> = {
  name: 120,
  email: 254,
  phone: 32,
  question: 2000,
  department: 32,
  text: 500,
  choice: 32,
};

/** Answers to a brand's form, checked against it, in the shapes the chat needs. */
export interface AcceptedAnswers {
  name: string | null;
  /** As typed: never verified, so never stored as the customer's address. */
  email: string | null;
  phone: string | null;
  question: string | null;
  /** The team a department answer leads to (its public id), when one was chosen. */
  teamId: string | null;
  /** "Label: answer" lines for staff, in the brand's English. */
  lines: string[];
  /** Contact attributes staff see beside the chat (internal `hv_` keys are never used here). */
  attributes: Record<string, string>;
}

/**
 * Checks answers against the form: required fields, plausible addresses and phone numbers, and
 * list answers that are one of the form's own. Answers to fields the form does not have are left
 * out (a page that loaded an older form may still send them). `path` prefixes field errors.
 */
export function acceptAnswers(
  fields: readonly ChatFormField[],
  answers: FormAnswers,
  path: string,
): AcceptedAnswers {
  const accepted: AcceptedAnswers = {
    name: null,
    email: null,
    phone: null,
    question: null,
    teamId: null,
    lines: [],
    attributes: {},
  };
  const problems: { path: string; message: string }[] = [];
  for (const field of fields) {
    const value = (answers[field.id] ?? '').trim();
    const at = `${path}.${field.id}`;
    if (!value) {
      if (field.required) problems.push({ path: at, message: 'This answer is required' });
      continue;
    }
    if (value.length > MAX_LENGTH[field.kind]) {
      problems.push({ path: at, message: `Use at most ${MAX_LENGTH[field.kind]} characters` });
      continue;
    }
    let shown = value;
    switch (field.kind) {
      case 'name':
        accepted.name = value;
        break;
      case 'email':
        if (!plausibleEmail(value)) {
          problems.push({ path: at, message: 'Enter an email address such as name@example.com' });
          continue;
        }
        accepted.email = value;
        accepted.attributes.form_email = value;
        shown = `${value} (not verified)`;
        break;
      case 'phone':
        if (!plausiblePhone(value)) {
          problems.push({ path: at, message: 'Enter a phone number' });
          continue;
        }
        accepted.phone = value;
        accepted.attributes.form_phone = value;
        break;
      case 'question':
        accepted.question = value;
        break;
      case 'department':
      case 'choice': {
        const option = field.options.find((o) => o.id === value);
        if (!option) {
          problems.push({ path: at, message: 'Choose one of the answers' });
          continue;
        }
        shown = option.label.en;
        if (field.kind === 'department') accepted.teamId = option.teamId;
        accepted.attributes[`form_${field.id}`] = option.label.en;
        break;
      }
      case 'text':
        accepted.attributes[`form_${field.id}`] = value;
        break;
    }
    accepted.lines.push(`${field.label.en}: ${shown}`);
  }
  if (problems.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Some answers need attention.',
      fields: problems,
    });
  }
  return accepted;
}

/** The note staff read at the start of the chat, with the customer's answers. */
export function answersNote(heading: string, accepted: AcceptedAnswers): string | null {
  if (accepted.lines.length === 0) return null;
  return [heading, ...accepted.lines.map((line) => `- ${line}`)].join('\n');
}
