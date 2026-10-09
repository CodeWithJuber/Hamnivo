/**
 * WhatsApp template messages (D14). After 24 hours without a word from the customer, WhatsApp
 * delivers only templates the business had approved by Meta. Chatwoot keeps the approved list
 * (synced from Meta, in Meta's own shape); these functions read it, list what each template asks
 * for, render the text the customer receives and build the `processed_params` Chatwoot sends.
 */

export type TemplateButtonType = 'quick_reply' | 'url' | 'phone_number' | 'copy_code' | 'other';

export interface WhatsappTemplate {
  name: string;
  /** Meta's language code, such as `en_US`. */
  language: string;
  /** `UTILITY`, `MARKETING` or `AUTHENTICATION`. */
  category: string;
  /** Meta's review status; only `APPROVED` can be sent. */
  status: string;
  /** `{{1}}` variables, or `{{name}}` ones. */
  parameterFormat: 'positional' | 'named';
  header: {
    format: 'text' | 'image' | 'video' | 'document' | 'location';
    text: string | null;
  } | null;
  body: string;
  footer: string | null;
  buttons: { type: TemplateButtonType; text: string; url: string | null }[];
}

/** What a template asks for before it can be sent. */
export interface TemplateVariables {
  header: string[];
  body: string[];
  /** Buttons that take a value: the end of a URL, or a coupon code to copy. */
  buttons: { index: number; type: 'url' | 'copy_code'; label: string }[];
}

/** The values staff fill in: header and body by variable, buttons by their index. */
export interface TemplateValues {
  header?: Record<string, string>;
  body?: Record<string, string>;
  buttons?: Record<string, string>;
}

/** Why a template cannot be sent from Hamnivo, when it cannot. */
export type TemplateUnsupported = 'not_approved' | 'media_header' | 'authentication';

/** Chatwoot's template params for `messages#create` (`processed_params` in its enhanced form). */
export interface TemplateProcessedParams {
  header?: Record<string, string>;
  body?: Record<string, string>;
  buttons?: { type: string; parameter?: string }[];
}

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** Meta limits a copy-code value to 15 characters; Chatwoot refuses longer ones. */
export const COUPON_CODE_MAX = 15;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** One template from Chatwoot's `message_templates`, or null when it is not one. */
export function parseWhatsappTemplate(raw: unknown): WhatsappTemplate | null {
  const t = obj(raw);
  const name = str(t.name);
  const language = str(t.language);
  if (!name || !language) return null;
  const components = Array.isArray(t.components) ? t.components.map(obj) : [];
  const part = (type: string) => components.find((c) => str(c.type)?.toUpperCase() === type);
  const header = part('HEADER');
  const headerFormat = (str(header?.format) ?? 'TEXT').toLowerCase();
  const buttons = Array.isArray(part('BUTTONS')?.buttons)
    ? (part('BUTTONS')?.buttons as unknown[]).map(obj)
    : [];
  return {
    name,
    language,
    category: (str(t.category) ?? 'UTILITY').toUpperCase(),
    status: (str(t.status) ?? '').toUpperCase(),
    parameterFormat: str(t.parameter_format)?.toUpperCase() === 'NAMED' ? 'named' : 'positional',
    header: header
      ? {
          format: (['text', 'image', 'video', 'document', 'location'].includes(headerFormat)
            ? headerFormat
            : 'document') as NonNullable<WhatsappTemplate['header']>['format'],
          text: str(header.text),
        }
      : null,
    body: str(part('BODY')?.text) ?? '',
    footer: str(part('FOOTER')?.text),
    buttons: buttons.map((b) => {
      const type = (str(b.type) ?? '').toLowerCase();
      return {
        type: (['quick_reply', 'url', 'phone_number', 'copy_code'].includes(type)
          ? type
          : 'other') as TemplateButtonType,
        text: str(b.text) ?? '',
        url: str(b.url),
      };
    }),
  };
}

function variablesIn(text: string | null): string[] {
  if (!text) return [];
  const seen: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function templateVariables(template: WhatsappTemplate): TemplateVariables {
  return {
    header: template.header?.format === 'text' ? variablesIn(template.header.text) : [],
    body: variablesIn(template.body),
    buttons: template.buttons.flatMap((button, index) => {
      if (button.type === 'copy_code')
        return [{ index, type: 'copy_code' as const, label: button.text }];
      if (button.type === 'url' && variablesIn(button.url).length > 0) {
        return [{ index, type: 'url' as const, label: button.text }];
      }
      return [];
    }),
  };
}

export function unsupportedReason(template: WhatsappTemplate): TemplateUnsupported | null {
  if (template.status !== 'APPROVED') return 'not_approved';
  // One-time codes are sent by the business's own systems, never typed by support.
  if (template.category === 'AUTHENTICATION') return 'authentication';
  if (template.header && template.header.format !== 'text') return 'media_header';
  return null;
}

/** Chatwoot strips these before it sends a value; the transcript shows what the customer got. */
function clean(value: string): string {
  return value
    .trim()
    .replace(/[<>"']/g, '')
    .slice(0, 1000);
}

/** The variables still empty, as `body.1`, `header.name` or `buttons.0`. */
export function missingValues(template: WhatsappTemplate, values: TemplateValues): string[] {
  const vars = templateVariables(template);
  const empty = (v: string | undefined) => !v || clean(v) === '';
  return [
    ...vars.header.filter((v) => empty(values.header?.[v])).map((v) => `header.${v}`),
    ...vars.body.filter((v) => empty(values.body?.[v])).map((v) => `body.${v}`),
    ...vars.buttons
      .filter((b) => empty(values.buttons?.[String(b.index)]))
      .map((b) => `buttons.${b.index}`),
  ];
}

/** Values the template does not ask for, or a coupon code longer than Meta allows. */
export function invalidValues(template: WhatsappTemplate, values: TemplateValues): string[] {
  const vars = templateVariables(template);
  const extra = (part: 'header' | 'body', known: string[]) =>
    Object.keys(values[part] ?? {})
      .filter((k) => !known.includes(k))
      .map((k) => `${part}.${k}`);
  const buttonKeys = vars.buttons.map((b) => String(b.index));
  return [
    ...extra('header', vars.header),
    ...extra('body', vars.body),
    ...Object.keys(values.buttons ?? {})
      .filter((k) => !buttonKeys.includes(k))
      .map((k) => `buttons.${k}`),
    ...vars.buttons
      .filter(
        (b) =>
          b.type === 'copy_code' &&
          clean(values.buttons?.[String(b.index)] ?? '').length > COUPON_CODE_MAX,
      )
      .map((b) => `buttons.${b.index}`),
  ];
}

function fill(text: string, values: Record<string, string> | undefined): string {
  return text.replace(VARIABLE, (whole, name: string) => {
    const value = values?.[name];
    return value === undefined ? whole : clean(value);
  });
}

/** The message as the customer reads it: header, body and footer, with the values filled in. */
export function renderTemplate(template: WhatsappTemplate, values: TemplateValues): string {
  return [
    template.header?.format === 'text' && template.header.text
      ? fill(template.header.text, values.header)
      : null,
    fill(template.body, values.body),
    template.footer,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
}

/**
 * Chatwoot's `processed_params`. Buttons keep their position (Meta addresses them by index), so a
 * button without a value still takes its place, with a type Chatwoot skips.
 */
export function templateProcessedParams(
  template: WhatsappTemplate,
  values: TemplateValues,
): TemplateProcessedParams {
  const vars = templateVariables(template);
  const pick = (names: string[], source: Record<string, string> | undefined) =>
    Object.fromEntries(names.map((n) => [n, clean(source?.[n] ?? '')]));
  const last = Math.max(-1, ...vars.buttons.map((b) => b.index));
  const buttons = Array.from({ length: last + 1 }, (_, index) => {
    const variable = vars.buttons.find((b) => b.index === index);
    return variable
      ? { type: variable.type, parameter: clean(values.buttons?.[String(index)] ?? '') }
      : { type: 'none' };
  });
  return {
    ...(vars.header.length ? { header: pick(vars.header, values.header) } : {}),
    ...(vars.body.length ? { body: pick(vars.body, values.body) } : {}),
    ...(buttons.length ? { buttons } : {}),
  };
}
