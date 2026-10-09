import { z } from 'zod';
import { SupportedLocale, Timestamp } from './common.js';
import { CustomerConversation, FormAnswers, PageContext } from './conversations.js';
import { LocalizedText } from './customer-surface.js';
import { typeId } from './ids.js';

/**
 * What the chat asks before it starts: a pre-chat form (W26), a contact form while nobody can
 * answer (W11), consent to keep the chat (W27), and a link that opens the chat on its own page
 * (W28). A brand sets them in Studio (widget.configure); the widget reads them from its config.
 */

/** The kinds of answer a form can ask for. */
export const CHAT_FORM_FIELD_KINDS = [
  'name',
  'email',
  'phone',
  'question',
  'department',
  'text',
  'choice',
] as const;
export const ChatFormFieldKind = z.enum(CHAT_FORM_FIELD_KINDS);
export type ChatFormFieldKind = z.infer<typeof ChatFormFieldKind>;

/** Kinds a form may hold only once: each fills one thing (the name, the address, the team…). */
export const SINGLE_CHAT_CHAT_FORM_FIELD_KINDS: readonly ChatFormFieldKind[] = [
  'name',
  'email',
  'phone',
  'question',
  'department',
];

/** Lower-case letters, digits and dashes; stable within the form. */
export const ChatFormFieldId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'Use lower-case letters, digits and dashes');

/** One answer to pick from a list. A department option names the support team it leads to. */
export const ChatFormFieldOption = z.object({
  id: ChatFormFieldId,
  label: LocalizedText(60),
  /** department only: the team a conversation goes to when the customer picks this. */
  teamId: typeId('team').nullable().default(null),
});
export type ChatFormFieldOption = z.infer<typeof ChatFormFieldOption>;

export const ChatFormField = z
  .object({
    id: ChatFormFieldId,
    kind: ChatFormFieldKind,
    label: LocalizedText(80),
    required: z.boolean().default(false),
    /** choice and department: 2 to 10 answers. */
    options: z.array(ChatFormFieldOption).max(10).default([]),
  })
  .superRefine((field, ctx) => {
    const listed = field.kind === 'choice' || field.kind === 'department';
    if (listed && field.options.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Give at least 2 answers' });
    }
    if (!listed && field.options.length > 0) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Only lists have answers' });
    }
    if (field.kind === 'department' && field.options.some((o) => o.teamId === null)) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Choose a team for each answer' });
    }
    if (new Set(field.options.map((o) => o.id)).size !== field.options.length) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Answer ids must be unique' });
    }
  });
export type ChatFormField = z.infer<typeof ChatFormField>;

const fieldList = (max: number) =>
  z
    .array(ChatFormField)
    .max(max)
    .superRefine((fields, ctx) => {
      if (new Set(fields.map((f) => f.id)).size !== fields.length) {
        ctx.addIssue({ code: 'custom', message: 'Field ids must be unique' });
      }
      for (const kind of SINGLE_CHAT_CHAT_FORM_FIELD_KINDS) {
        if (fields.filter((f) => f.kind === kind).length > 1) {
          ctx.addIssue({ code: 'custom', message: `Ask for the ${kind} once` });
        }
      }
    });

/** The most fields one form may ask; a longer form loses the customers it is meant to help. */
export const CHAT_FORM_MAX_FIELDS = 6;

const defaultField = (
  kind: 'name' | 'email' | 'question',
  required: boolean,
  label: { en: string; ar: string; hi: string; ur: string },
): ChatFormField => ({ id: kind, kind, label, required, options: [] });

const nameField = (required: boolean) =>
  defaultField('name', required, { en: 'Your name', ar: 'اسمك', hi: 'आपका नाम', ur: 'آپ کا نام' });

const emailField = () =>
  defaultField('email', true, {
    en: 'Your email',
    ar: 'بريدك الإلكتروني',
    hi: 'आपका ईमेल',
    ur: 'آپ کی ای میل',
  });

const questionField = () =>
  defaultField('question', true, {
    en: 'How can we help?',
    ar: 'كيف يمكننا المساعدة؟',
    hi: 'हम कैसे मदद कर सकते हैं?',
    ur: 'ہم کیسے مدد کر سکتے ہیں؟',
  });

/** Asked before a chat starts (W26). Off until a brand turns it on. */
export const PrechatForm = z.object({
  enabled: z.boolean().default(false),
  fields: fieldList(CHAT_FORM_MAX_FIELDS).default(() => [nameField(true)]),
  /** Customers the website signed in are known already: they go straight to the chat. */
  skipVerified: z.boolean().default(true),
});
export type PrechatForm = z.infer<typeof PrechatForm>;

/** When the contact form replaces "Talk to a person". */
export const OfflineFormWhen = z.enum(['closed', 'nobody_online', 'either']);
export type OfflineFormWhen = z.infer<typeof OfflineFormWhen>;

/**
 * A contact form for when nobody can answer (W11). What the customer writes becomes a ticket
 * (H19), answered by email once they confirm the address, and in the chat when they come back.
 * The form always asks for an email address, since that is how the answer reaches them.
 */
export const OfflineForm = z
  .object({
    enabled: z.boolean().default(true),
    when: OfflineFormWhen.default('either'),
    fields: fieldList(CHAT_FORM_MAX_FIELDS).default(() => [
      nameField(false),
      emailField(),
      questionField(),
    ]),
    /** What the customer reads after sending; Hamnivo's own words when left out. */
    thanks: LocalizedText(300).nullable().default(null),
    /** Let the AI assistant answer the message first; people follow up when it hands over. */
    aiFirst: z.boolean().default(false),
  })
  .superRefine((form, ctx) => {
    const email = form.fields.find((f) => f.kind === 'email');
    if (!email?.required) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'The contact form needs a required email field, so the answer can reach them',
      });
    }
    if (!form.fields.some((f) => f.kind === 'question' && f.required)) {
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'The contact form needs a required question field',
      });
    }
  });
export type OfflineForm = z.infer<typeof OfflineForm>;

export const WidgetForms = z
  .object({ prechat: PrechatForm.prefault({}), offline: OfflineForm.prefault({}) })
  .meta({ id: 'WidgetForms' });
export type WidgetForms = z.infer<typeof WidgetForms>;

export const UpdateWidgetFormsRequest = WidgetForms.meta({ id: 'UpdateWidgetFormsRequest' });

export const WidgetFormsView = z
  .object({
    brandId: z.string(),
    forms: WidgetForms,
    configVersion: z.int().positive(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'WidgetFormsView' });
export type WidgetFormsView = z.infer<typeof WidgetFormsView>;

// ── Consent (W27) ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is asked to agree before chatting: nobody, every visitor, or visitors whose connection
 * comes from the EU, the EEA or the UK. The country is read per request and never stored.
 */
export const ConsentMode = z.enum(['off', 'everyone', 'eu']);
export type ConsentMode = z.infer<typeof ConsentMode>;

export const ConsentSettings = z
  .object({
    mode: ConsentMode.default('off'),
    /** The words the customer agrees to; Hamnivo's own when left out. */
    text: LocalizedText(500).nullable().default(null),
  })
  .meta({ id: 'ConsentSettings' });
export type ConsentSettings = z.infer<typeof ConsentSettings>;

export const UpdateConsentSettingsRequest = ConsentSettings.meta({
  id: 'UpdateConsentSettingsRequest',
});

export const ConsentSettingsView = z
  .object({
    brandId: z.string(),
    consent: ConsentSettings,
    /**
     * Goes up whenever the words change; customers who agreed to older words are asked again.
     * 0 before the brand saved any.
     */
    noticeVersion: z.int().nonnegative(),
    configVersion: z.int().positive(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'ConsentSettingsView' });
export type ConsentSettingsView = z.infer<typeof ConsentSettingsView>;

/** The customer agreed to the words of this version (it must be the current one). */
export const ConsentRequest = z
  .object({ noticeVersion: z.int().nonnegative() })
  .meta({ id: 'ConsentRequest' });

// ── Direct chat link (W28) ────────────────────────────────────────────────────────────────────

export const DirectLinkSettings = z
  .object({ enabled: z.boolean().default(false) })
  .meta({ id: 'DirectLinkSettings' });
export type DirectLinkSettings = z.infer<typeof DirectLinkSettings>;

export const UpdateDirectLinkRequest = DirectLinkSettings.meta({ id: 'UpdateDirectLinkRequest' });

export const DirectLinkView = z
  .object({
    brandId: z.string(),
    enabled: z.boolean(),
    /** The page that opens the chat on its own; null when the chat's address is not configured. */
    url: z.url().nullable(),
    configVersion: z.int().positive(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'DirectLinkView' });
export type DirectLinkView = z.infer<typeof DirectLinkView>;

// ── What the widget reads ─────────────────────────────────────────────────────────────────────

/** A form field as the widget shows it: every label in every language (English fills gaps). */
export const WidgetFormField = z.object({
  id: z.string(),
  kind: ChatFormFieldKind,
  label: z.record(SupportedLocale, z.string()),
  required: z.boolean(),
  options: z.array(z.object({ id: z.string(), label: z.record(SupportedLocale, z.string()) })),
});
export type WidgetFormField = z.infer<typeof WidgetFormField>;

/** The forms and consent in the widget's configuration. */
export const WidgetFormsConfig = z.object({
  prechat: z.object({
    enabled: z.boolean(),
    skipVerified: z.boolean(),
    fields: z.array(WidgetFormField),
  }),
  offline: z.object({
    enabled: z.boolean(),
    when: OfflineFormWhen,
    fields: z.array(WidgetFormField),
    thanks: z.record(SupportedLocale, z.string()),
  }),
});
export type WidgetFormsConfig = z.infer<typeof WidgetFormsConfig>;

export const WidgetConsentConfig = z.object({
  /** This visitor must agree before a chat starts (decided per request from the brand's mode). */
  required: z.boolean(),
  /** This customer already agreed to the current words. */
  given: z.boolean(),
  noticeVersion: z.int().nonnegative(),
  text: z.record(SupportedLocale, z.string()),
});
export type WidgetConsentConfig = z.infer<typeof WidgetConsentConfig>;

// ── Offline messages (W11 → H19) ──────────────────────────────────────────────────────────────

export const OfflineMessageRequest = z
  .object({
    /** Makes a retry of the same send create nothing twice. */
    clientRequestId: z.uuid(),
    answers: FormAnswers,
    context: PageContext.optional(),
  })
  .meta({ id: 'OfflineMessageRequest' });
export type OfflineMessageRequest = z.infer<typeof OfflineMessageRequest>;

export const OfflineMessageResponse = z
  .object({
    conversation: CustomerConversation,
    /** The ticket's reference, such as #1042, to quote later. */
    reference: z.string(),
    /** The address the confirmation went to, partly hidden (f•••@example.com). */
    email: z.string(),
    /** False when a confirmation went to this address a short while ago and was not resent. */
    confirmationSent: z.boolean(),
  })
  .meta({ id: 'OfflineMessageResponse' });
export type OfflineMessageResponse = z.infer<typeof OfflineMessageResponse>;

export const EmailConfirmationQuery = z.object({
  token: z
    .string()
    .min(20)
    .max(1024)
    .meta({ description: 'Signed confirmation token from the email' }),
});
