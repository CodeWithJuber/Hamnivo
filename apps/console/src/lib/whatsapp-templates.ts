/**
 * WhatsApp template messages in the composer (D14): what a template asks for, values Studio can
 * fill in from the conversation, and its text with the values in for the preview. The server
 * checks and renders the message again; this only helps staff fill it in.
 */
import type { InboxDetail, TemplateValues, WhatsappTemplate } from './inbox';

export type TemplatePart = 'header' | 'body' | 'buttons';

/** One value to fill in: `key` is how the server names it (`body.1`, `buttons.0`). */
export interface TemplateField {
  key: string;
  part: TemplatePart;
  /** The variable (`1`, `name`) or, for a button, its position. */
  name: string;
  /** Buttons: the button's text and kind. */
  label?: string;
  button?: 'url' | 'copy_code';
}

/** Meta allows at most 15 characters in a coupon code. */
export const COPY_CODE_MAX = 15;

const VARIABLE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Every value the template asks for: header, then body, then buttons. */
export function templateFields(template: WhatsappTemplate): TemplateField[] {
  const { header, body, buttons } = template.variables;
  return [
    ...header.map((name) => ({ key: `header.${name}`, part: 'header' as const, name })),
    ...body.map((name) => ({ key: `body.${name}`, part: 'body' as const, name })),
    ...buttons.map((b) => ({
      key: `buttons.${b.index}`,
      part: 'buttons' as const,
      name: String(b.index),
      label: b.label,
      button: b.type,
    })),
  ];
}

const NAMES = new Set(['name', 'customer', 'customer_name', 'full_name', 'contact_name']);
const FIRST_NAMES = new Set(['first_name', 'firstname', 'customer_first_name']);
const TICKETS = new Set(['order', 'ticket', 'order_number', 'ticket_number', 'order_id']);
const BRANDS = new Set(['brand', 'shop', 'brand_name', 'shop_name', 'store', 'company']);

/**
 * Values Studio knows from the conversation, for variables with a telling name: the customer's
 * name, the ticket number and the brand. Numbered variables (`{{1}}`) and buttons are left empty.
 */
export function prefill(
  template: WhatsappTemplate,
  detail: Pick<InboxDetail, 'customer' | 'ticket' | 'brand'>,
): Record<string, string> {
  const name = detail.customer.displayName.trim();
  const known = (variable: string): string | null => {
    const v = variable.toLowerCase();
    if (NAMES.has(v)) return name || null;
    if (FIRST_NAMES.has(v)) return name.split(/\s+/)[0] || null;
    if (TICKETS.has(v)) return detail.ticket ? String(detail.ticket.number) : null;
    if (BRANDS.has(v)) return detail.brand?.name ?? null;
    return null;
  };
  const out: Record<string, string> = {};
  for (const field of templateFields(template)) {
    if (field.part === 'buttons') continue;
    const value = known(field.name);
    if (value) out[field.key] = value;
  }
  return out;
}

/** The fields still empty (or a code that is too long), by key. */
export function unfilled(fields: readonly TemplateField[], values: Record<string, string>) {
  return fields.filter((f) => {
    const value = values[f.key]?.trim() ?? '';
    return value === '' || (f.button === 'copy_code' && value.length > COPY_CODE_MAX);
  });
}

/** The values as the send request takes them, only those the template asks for. */
export function templateValues(
  fields: readonly TemplateField[],
  values: Record<string, string>,
): TemplateValues {
  const out: TemplateValues = {};
  for (const field of fields) {
    const part = out[field.part] ?? {};
    part[field.name] = values[field.key]?.trim() ?? '';
    out[field.part] = part;
  }
  return out;
}

/** A piece of template text for the preview: plain text, or a variable with its value (if any). */
export type PreviewPiece = { text: string; variable?: string; filled?: boolean };

export function previewPieces(
  text: string,
  part: 'header' | 'body',
  values: Record<string, string>,
): PreviewPiece[] {
  const pieces: PreviewPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(VARIABLE)) {
    const index = match.index ?? 0;
    if (index > at) pieces.push({ text: text.slice(at, index) });
    const name = match[1] ?? '';
    const value = values[`${part}.${name}`]?.trim();
    pieces.push(
      value
        ? { text: value, variable: name, filled: true }
        : { text: match[0], variable: name, filled: false },
    );
    at = index + match[0].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Templates by language, in the order they first appear; ones that can be sent first in each. */
export function byLanguage(items: readonly WhatsappTemplate[]) {
  const groups = new Map<string, WhatsappTemplate[]>();
  for (const item of items) {
    const group = groups.get(item.language) ?? [];
    group.push(item);
    groups.set(item.language, group);
  }
  return [...groups].map(([language, templates]) => ({
    language,
    templates: [
      ...templates.filter((t) => !t.unsupported),
      ...templates.filter((t) => t.unsupported),
    ],
  }));
}

/** Templates whose name or text contains the search. */
export function matchTemplates(items: readonly WhatsappTemplate[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((t) =>
    [t.name, t.name.replace(/_/g, ' '), t.header ?? '', t.body, t.footer ?? ''].some((text) =>
      text.toLowerCase().includes(q),
    ),
  );
}

/** Meta's language code (`en_US`) named in the interface language, or the code itself. */
export function languageName(code: string, uiLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([uiLocale], { type: 'language' }).of(code.replace('_', '-')) ?? code
    );
  } catch {
    return code;
  }
}
