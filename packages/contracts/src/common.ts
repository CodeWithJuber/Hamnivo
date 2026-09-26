import { z } from 'zod';

/** RFC 3339 timestamp with offset, e.g. 2026-09-26T19:00:00Z. */
export const Timestamp = z.iso
  .datetime({ offset: true })
  .meta({ description: 'RFC 3339 timestamp' });

/** BCP 47 language tag (e.g. en, ar, hi-Latn, ur-Latn). Language does not imply direction or culture. */
export const LanguageTag = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/, 'Expected a BCP 47 language tag')
  .meta({ description: 'BCP 47 language tag', example: 'hi-Latn' });

/** Interface locales shipped in the first release. */
export const SupportedLocale = z.enum(['en', 'ar', 'hi', 'ur']);
export type SupportedLocale = z.infer<typeof SupportedLocale>;
export const RTL_LOCALES: ReadonlySet<string> = new Set(['ar', 'ur', 'fa', 'he']);

/** Opaque pagination cursor. Clients must not parse it. */
export const Cursor = z.string().min(1).max(512).meta({ description: 'Opaque pagination cursor' });

export function page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: Cursor.nullable(),
  });
}

/** ISO 4217 currency code. */
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code');

/**
 * Money is an integer count of the currency's minor unit, serialized as a string so values beyond
 * 2^53 and exact arithmetic survive JSON. Display formatting uses Intl.NumberFormat.
 */
export const MinorUnits = z
  .string()
  .regex(/^-?(0|[1-9][0-9]{0,17})$/, 'Expected an integer amount in minor units')
  .meta({
    description: 'Integer amount in the currency minor unit, as a string',
    example: '14900',
  });

export const Money = z
  .object({ amountMinor: MinorUnits, currency: CurrencyCode })
  .meta({ id: 'Money' });
export type Money = z.infer<typeof Money>;

export const Visibility = z.enum(['public', 'internal']);
export type Visibility = z.infer<typeof Visibility>;

/** Conversation lanes (blueprint §21): each has independent server-side authorization. */
export const Lane = z.enum(['customer', 'staff', 'agent_work']);
export type Lane = z.infer<typeof Lane>;

/** A client-generated idempotency key for a send (UUID). */
export const ClientMessageId = z
  .uuid()
  .meta({ description: 'Client-generated UUID identifying one send attempt' });

export const Json: z.ZodType<unknown> = z.json();
