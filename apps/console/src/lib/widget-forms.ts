/**
 * What the chat asks before it starts (the pre-chat form, W26), the contact form for when nobody
 * can answer (W11), consent before chatting (W27) and the direct chat link (W28): the working
 * copies Studio edits, what is sent for them, and what is wrong with them before they are sent.
 *
 * The gateway checks all of it again and is the one that decides; the rules here mirror the
 * contract (`packages/contracts/src/widget-forms.ts`) so a person hears in plain words, before
 * saving, what it would refuse. Studio imports only the contract's types, so the schema library
 * stays out of the page; `test/widget-forms.test.ts` fails when the lists here drift from it.
 */
import type * as C from '@hamnivo/contracts';
import { api } from './api';
import { CHAT_LANGUAGES, type ChatTexts, localizedOf, textsOf } from './appearance';
import { useStudioMutation, useStudioQuery } from './queries';
import type { ChatLanguage } from './setup-data';

export type FieldKind = C.ChatFormFieldKind;
export type FormName = 'prechat' | 'offline';
export type OfflineWhen = C.OfflineFormWhen;
export type ConsentMode = C.ConsentMode;

/** Every kind of answer a form can ask for, in the order the kind list offers them. */
export const FIELD_KINDS: readonly FieldKind[] = [
  'name',
  'email',
  'phone',
  'question',
  'department',
  'text',
  'choice',
];
/** Kinds a form may ask only once: each fills one thing (the name, the address, the team…). */
export const SINGLE_KINDS: readonly FieldKind[] = [
  'name',
  'email',
  'phone',
  'question',
  'department',
];
/** Kinds the customer answers by picking from a list. */
export const LIST_KINDS: readonly FieldKind[] = ['choice', 'department'];
/** The most fields one form may ask; a longer form loses the customers it is meant to help. */
export const MAX_FIELDS = 6;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;
export const LABEL_MAX = 80;
export const OPTION_LABEL_MAX = 60;
export const THANKS_MAX = 300;
export const CONSENT_MAX = 500;
export const OFFLINE_WHEN: readonly OfflineWhen[] = ['either', 'closed', 'nobody_online'];
export const CONSENT_MODES: readonly ConsentMode[] = ['off', 'everyone', 'eu'];

export const isListKind = (kind: FieldKind) => LIST_KINDS.includes(kind);

/**
 * The words a new field starts with, in each language of the chat. They are what customers read
 * until the brand writes its own, so they are plain and short.
 */
export const DEFAULT_FIELD_LABELS: Readonly<Record<FieldKind, Readonly<ChatTexts>>> = {
  name: { en: 'Your name', ar: 'اسمك', hi: 'आपका नाम', ur: 'آپ کا نام' },
  email: { en: 'Your email', ar: 'بريدك الإلكتروني', hi: 'आपका ईमेल', ur: 'آپ کی ای میل' },
  phone: {
    en: 'Your phone number',
    ar: 'رقم هاتفك',
    hi: 'आपका फ़ोन नंबर',
    ur: 'آپ کا فون نمبر',
  },
  question: {
    en: 'How can we help?',
    ar: 'كيف يمكننا المساعدة؟',
    hi: 'हम कैसे मदद कर सकते हैं?',
    ur: 'ہم کیسے مدد کر سکتے ہیں؟',
  },
  department: {
    en: 'What is it about?',
    ar: 'ما موضوع سؤالك؟',
    hi: 'आपका सवाल किस बारे में है?',
    ur: 'آپ کا سوال کس بارے میں ہے؟',
  },
  text: {
    en: 'Anything else we should know?',
    ar: 'هل هناك شيء آخر يجب أن نعرفه؟',
    hi: 'क्या कुछ और है जो हमें जानना चाहिए?',
    ur: 'کیا کچھ اور ہے جو ہمیں جاننا چاہیے؟',
  },
  choice: { en: 'Choose one', ar: 'اختر واحدًا', hi: 'एक चुनें', ur: 'ایک منتخب کریں' },
};

// ── The working copy ──────────────────────────────────────────────────────────────────────────

export interface OptionDraft {
  /** Stable within the field; answers are stored by it. */
  id: string;
  label: ChatTexts;
  /** department only: the team the conversation goes to; '' until one is chosen. */
  teamId: string;
}

export interface FieldDraft {
  /** Stable within the form; answers are stored by it, so it never changes once made. */
  id: string;
  kind: FieldKind;
  label: ChatTexts;
  required: boolean;
  /** Kept while the kind is not a list, so switching back does not lose what was written. */
  options: OptionDraft[];
}

export interface PrechatDraft {
  enabled: boolean;
  skipVerified: boolean;
  fields: FieldDraft[];
}

export interface OfflineDraft {
  enabled: boolean;
  when: OfflineWhen;
  fields: FieldDraft[];
  thanks: ChatTexts;
  aiFirst: boolean;
}

export interface FormsDraft {
  prechat: PrechatDraft;
  offline: OfflineDraft;
}

const fieldDraftOf = (field: C.ChatFormField): FieldDraft => ({
  id: field.id,
  kind: field.kind,
  label: textsOf(field.label),
  required: field.required,
  options: field.options.map((option) => ({
    id: option.id,
    label: textsOf(option.label),
    teamId: option.teamId ?? '',
  })),
});

export const draftOf = (forms: C.WidgetForms): FormsDraft => ({
  prechat: {
    enabled: forms.prechat.enabled,
    skipVerified: forms.prechat.skipVerified,
    fields: forms.prechat.fields.map(fieldDraftOf),
  },
  offline: {
    enabled: forms.offline.enabled,
    when: forms.offline.when,
    fields: forms.offline.fields.map(fieldDraftOf),
    thanks: textsOf(forms.offline.thanks),
    aiFirst: forms.offline.aiFirst,
  },
});

/** English plus the languages written; English is required (`problemsOf` says so when missing). */
export function labelOf(texts: ChatTexts): C.LocalizedText {
  const out: Partial<Record<ChatLanguage, string>> = {};
  for (const lang of CHAT_LANGUAGES) {
    const text = texts[lang].trim();
    if (text) out[lang] = text;
  }
  return { ...out, en: texts.en.trim() };
}

const fieldBodyOf = (field: FieldDraft): C.ChatFormField => ({
  id: field.id,
  kind: field.kind,
  label: labelOf(field.label),
  required: field.required,
  options: isListKind(field.kind)
    ? field.options.map((option) => ({
        id: option.id,
        label: labelOf(option.label),
        teamId: field.kind === 'department' ? option.teamId || null : null,
      }))
    : [],
});

/** What is saved for a draft. */
export const bodyOf = (draft: FormsDraft): C.WidgetForms => ({
  prechat: {
    enabled: draft.prechat.enabled,
    skipVerified: draft.prechat.skipVerified,
    fields: draft.prechat.fields.map(fieldBodyOf),
  },
  offline: {
    enabled: draft.offline.enabled,
    when: draft.offline.when,
    fields: draft.offline.fields.map(fieldBodyOf),
    thanks: localizedOf(draft.offline.thanks),
    aiFirst: draft.offline.aiFirst,
  },
});

/** Whether saving would change anything (the hidden answers of a non-list field do not count). */
export const isDirty = (draft: FormsDraft, saved: FormsDraft): boolean =>
  JSON.stringify(bodyOf(draft)) !== JSON.stringify(bodyOf(saved));

// ── Changes to the working copy ───────────────────────────────────────────────────────────────

/** The first id from `base`, `base-2`, `base-3`… that is not taken. */
export function freeId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const id = `${base}-${n}`;
    if (!taken.includes(id)) return id;
  }
}

const emptyOption = (taken: readonly string[]): OptionDraft => ({
  id: freeId('option', taken),
  label: textsOf(null),
  teamId: '',
});

/** Fills a list up to the fewest answers a list may have, with empty answers to write. */
function withEnoughOptions(options: OptionDraft[]): OptionDraft[] {
  const out = [...options];
  while (out.length < MIN_OPTIONS) out.push(emptyOption(out.map((option) => option.id)));
  return out;
}

const sameTexts = (a: ChatTexts, b: Readonly<ChatTexts>) =>
  CHAT_LANGUAGES.every((lang) => a[lang] === b[lang]);

/** The kind a new field asks for: the first common one the form does not ask yet. */
export function nextKind(fields: readonly FieldDraft[]): FieldKind {
  const used = new Set(fields.map((field) => field.kind));
  return (
    (['name', 'email', 'phone', 'question'] as const).find((kind) => !used.has(kind)) ?? 'text'
  );
}

/** A field to add to a form, with words customers can read until the brand writes its own. */
export function newField(fields: readonly FieldDraft[]): FieldDraft {
  const kind = nextKind(fields);
  return {
    id: freeId(
      kind,
      fields.map((field) => field.id),
    ),
    kind,
    label: { ...DEFAULT_FIELD_LABELS[kind] },
    required: kind === 'email' || kind === 'question',
    options: isListKind(kind) ? withEnoughOptions([]) : [],
  };
}

/**
 * A field asking for another kind of answer. Words still at the old kind's default become the new
 * kind's; an email or a question becomes required (a contact form needs both); a list gets room
 * for its answers.
 */
export function withKind(field: FieldDraft, kind: FieldKind): FieldDraft {
  return {
    ...field,
    kind,
    label: sameTexts(field.label, DEFAULT_FIELD_LABELS[field.kind])
      ? { ...DEFAULT_FIELD_LABELS[kind] }
      : field.label,
    required: kind === 'email' || kind === 'question' ? true : field.required,
    options: isListKind(kind) ? withEnoughOptions(field.options) : field.options,
  };
}

export const addOption = (field: FieldDraft): FieldDraft => ({
  ...field,
  options: [...field.options, emptyOption(field.options.map((option) => option.id))],
});

/** The list with the item at `index` moved one place up (-1) or down (+1). */
export function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= items.length) return [...items];
  const out = [...items];
  const [item] = out.splice(index, 1);
  if (item !== undefined) out.splice(to, 0, item);
  return out;
}

/**
 * In the contact form, the email field and the question field cannot be dropped or made optional:
 * the answer is emailed to that address, and the question is what the team answers.
 */
export const isLockedInOffline = (form: FormName, field: FieldDraft) =>
  form === 'offline' && (field.kind === 'email' || field.kind === 'question');

// ── What would be refused ─────────────────────────────────────────────────────────────────────

export type FormProblem =
  | { form: FormName; kind: 'label'; field: string; index: number }
  | { form: FormName; kind: 'duplicateKind'; field: string; index: number; fieldKind: FieldKind }
  | { form: FormName; kind: 'fewOptions'; field: string; index: number }
  | { form: FormName; kind: 'manyOptions'; field: string; index: number }
  | { form: FormName; kind: 'optionLabel'; field: string; index: number; option: string }
  | { form: FormName; kind: 'optionTeam'; field: string; index: number; option: string }
  | { form: FormName; kind: 'tooManyFields' }
  | { form: 'offline'; kind: 'needsEmail' }
  | { form: 'offline'; kind: 'needsQuestion' }
  | { form: 'offline'; kind: 'thanksEnglish' };

/** Other languages fall back to English, so there has to be an English text to fall back to. */
const needsEnglish = (texts: ChatTexts) =>
  !texts.en.trim() && CHAT_LANGUAGES.some((lang) => texts[lang].trim());

function fieldProblems(form: FormName, fields: readonly FieldDraft[]): FormProblem[] {
  const out: FormProblem[] = [];
  const seen = new Set<FieldKind>();
  fields.forEach((field, index) => {
    const at = { form, field: field.id, index };
    if (!field.label.en.trim()) out.push({ ...at, kind: 'label' });
    if (SINGLE_KINDS.includes(field.kind)) {
      if (seen.has(field.kind)) out.push({ ...at, kind: 'duplicateKind', fieldKind: field.kind });
      seen.add(field.kind);
    }
    if (!isListKind(field.kind)) return;
    if (field.options.length < MIN_OPTIONS) out.push({ ...at, kind: 'fewOptions' });
    if (field.options.length > MAX_OPTIONS) out.push({ ...at, kind: 'manyOptions' });
    for (const option of field.options) {
      if (!option.label.en.trim()) out.push({ ...at, kind: 'optionLabel', option: option.id });
      if (field.kind === 'department' && !option.teamId) {
        out.push({ ...at, kind: 'optionTeam', option: option.id });
      }
    }
  });
  if (fields.length > MAX_FIELDS) out.push({ form, kind: 'tooManyFields' });
  return out;
}

/** What would be refused, in the order the page shows it; nothing is listed for what is fine. */
export function problemsOf(draft: FormsDraft): FormProblem[] {
  const out = [
    ...fieldProblems('prechat', draft.prechat.fields),
    ...fieldProblems('offline', draft.offline.fields),
  ];
  const { fields } = draft.offline;
  if (!fields.some((field) => field.kind === 'email' && field.required)) {
    out.push({ form: 'offline', kind: 'needsEmail' });
  }
  if (!fields.some((field) => field.kind === 'question' && field.required)) {
    out.push({ form: 'offline', kind: 'needsQuestion' });
  }
  if (needsEnglish(draft.offline.thanks)) out.push({ form: 'offline', kind: 'thanksEnglish' });
  return out;
}

// ── Where each control is ─────────────────────────────────────────────────────────────────────

/** The ids of a form's controls, so errors and the summary point at the right one. */
export const formIds = {
  section: (form: FormName) => `${form}-form`,
  enabled: (form: FormName) => `${form}-enabled`,
  fields: (form: FormName) => `${form}-fields`,
  addField: (form: FormName) => `${form}-add-field`,
  field: (form: FormName, field: string) => `${form}-field-${field}`,
  kind: (form: FormName, field: string) => `${form}-field-${field}-kind`,
  label: (form: FormName, field: string) => `${form}-field-${field}-label`,
  required: (form: FormName, field: string) => `${form}-field-${field}-required`,
  addOption: (form: FormName, field: string) => `${form}-field-${field}-add-option`,
  optionLabel: (form: FormName, field: string, option: string) =>
    `${form}-field-${field}-option-${option}-label`,
  optionTeam: (form: FormName, field: string, option: string) =>
    `${form}-field-${field}-option-${option}-team`,
  skipVerified: 'prechat-skip-verified',
  when: 'offline-when',
  thanks: 'offline-thanks',
  aiFirst: 'offline-ai-first',
} as const;

/** The control a problem is about (an English text box for missing words). */
export function problemControl(problem: FormProblem): string {
  switch (problem.kind) {
    case 'label':
      return `${formIds.label(problem.form, problem.field)}-en`;
    case 'duplicateKind':
      return formIds.kind(problem.form, problem.field);
    case 'fewOptions':
    case 'manyOptions':
      return formIds.addOption(problem.form, problem.field);
    case 'optionLabel':
      return `${formIds.optionLabel(problem.form, problem.field, problem.option)}-en`;
    case 'optionTeam':
      return formIds.optionTeam(problem.form, problem.field, problem.option);
    case 'tooManyFields':
    case 'needsEmail':
    case 'needsQuestion':
      return formIds.fields(problem.form);
    case 'thanksEnglish':
      return `${formIds.thanks}-en`;
  }
}

const isIndex = (part: string | undefined): part is string =>
  part !== undefined && /^\d+$/.test(part);

/**
 * The control a gateway refusal is about, from the path it names (`offline.fields.1.label.en`).
 * A path Studio does not know points at the top of the form it is in.
 */
export function controlOfPath(path: string, draft: FormsDraft): string {
  const [form, key, index, part, optionIndex, optionPart] = path.split('.');
  if (form !== 'prechat' && form !== 'offline') return formIds.section('prechat');
  if (key === 'enabled') return formIds.enabled(form);
  if (key === 'skipVerified') return formIds.skipVerified;
  if (key === 'when') return `${formIds.when}-${draft.offline.when}`;
  if (key === 'thanks') return `${formIds.thanks}-en`;
  if (key === 'aiFirst') return formIds.aiFirst;
  if (key !== 'fields') return formIds.section(form);
  const field = isIndex(index) ? draft[form].fields[Number(index)] : undefined;
  if (!field) return formIds.fields(form);
  if (part === 'label') return `${formIds.label(form, field.id)}-en`;
  if (part === 'required') return formIds.required(form, field.id);
  if (part === 'options') {
    const option = isIndex(optionIndex) ? field.options[Number(optionIndex)] : undefined;
    if (!option) return formIds.addOption(form, field.id);
    return optionPart === 'teamId'
      ? formIds.optionTeam(form, field.id, option.id)
      : `${formIds.optionLabel(form, field.id, option.id)}-en`;
  }
  return formIds.kind(form, field.id);
}

// ── Consent (W27) ─────────────────────────────────────────────────────────────────────────────

export interface ConsentDraft {
  mode: ConsentMode;
  text: ChatTexts;
}

export const consentDraftOf = (consent: C.ConsentSettings): ConsentDraft => ({
  mode: consent.mode,
  text: textsOf(consent.text),
});

/** What is saved; words left empty are Hamnivo's own. */
export const consentBodyOf = (draft: ConsentDraft): C.ConsentSettings => ({
  mode: draft.mode,
  text: localizedOf(draft.text),
});

export const isConsentDirty = (draft: ConsentDraft, saved: ConsentDraft): boolean =>
  JSON.stringify(consentBodyOf(draft)) !== JSON.stringify(consentBodyOf(saved));

/** New words mean customers who agreed to the old ones are asked again. */
export const consentWordsChanged = (draft: ConsentDraft, saved: ConsentDraft): boolean =>
  JSON.stringify(consentBodyOf(draft).text) !== JSON.stringify(consentBodyOf(saved).text);

export type ConsentProblem = 'english';

export function consentProblemsOf(draft: ConsentDraft): ConsentProblem[] {
  return needsEnglish(draft.text) ? ['english'] : [];
}

// ── Reading and saving ────────────────────────────────────────────────────────────────────────

export type WidgetFormsView = C.WidgetFormsView;
export type ConsentSettingsView = C.ConsentSettingsView;
export type DirectLinkView = C.DirectLinkView;

export const widgetFormKeys = {
  forms: (brandId: string) => ['widget-forms', brandId],
  consent: (brandId: string) => ['widget-consent', brandId],
  directLink: (brandId: string) => ['widget-direct-link', brandId],
} as const;

const brandPath = (brandId: string, rest: string) =>
  `/v1/admin/brands/${encodeURIComponent(brandId)}/${rest}`;

export const useWidgetForms = (brandId: string, enabled = true) =>
  useStudioQuery<WidgetFormsView>(
    widgetFormKeys.forms(brandId),
    brandPath(brandId, 'widget-forms'),
    {
      enabled,
    },
  );

export const useSaveWidgetForms = (brandId: string) =>
  useStudioMutation(
    (body: C.WidgetForms, tenant) =>
      api<WidgetFormsView>(brandPath(brandId, 'widget-forms'), { method: 'PUT', body, tenant }),
    [widgetFormKeys.forms(brandId)],
  );

export const useConsentSettings = (brandId: string, enabled = true) =>
  useStudioQuery<ConsentSettingsView>(
    widgetFormKeys.consent(brandId),
    brandPath(brandId, 'consent'),
    {
      enabled,
    },
  );

export const useSaveConsent = (brandId: string) =>
  useStudioMutation(
    (body: C.ConsentSettings, tenant) =>
      api<ConsentSettingsView>(brandPath(brandId, 'consent'), { method: 'PUT', body, tenant }),
    [widgetFormKeys.consent(brandId)],
  );

export const useDirectLink = (brandId: string, enabled = true) =>
  useStudioQuery<DirectLinkView>(
    widgetFormKeys.directLink(brandId),
    brandPath(brandId, 'direct-link'),
    { enabled },
  );

export const useSaveDirectLink = (brandId: string) =>
  useStudioMutation(
    (body: { enabled: boolean }, tenant) =>
      api<DirectLinkView>(brandPath(brandId, 'direct-link'), { method: 'PUT', body, tenant }),
    [widgetFormKeys.directLink(brandId)],
  );
