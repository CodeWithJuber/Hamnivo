import { z } from 'zod';
import { SupportedLocale } from './common.js';

/** Reply languages as BCP 47 tags: Hinglish is `hi-Latn`, Roman Urdu `ur-Latn`. */
export const ReplyLanguage = z
  .enum(['en', 'ar', 'hi', 'ur', 'hi-Latn', 'ur-Latn'])
  .meta({ id: 'ReplyLanguage' });
export type ReplyLanguage = z.infer<typeof ReplyLanguage>;

export const CommunicationStyle = z
  .object({
    verbosity: z.enum(['concise', 'conversational', 'formal']).nullable(),
    tone: z.enum(['gentle', 'direct']).nullable(),
  })
  .meta({ id: 'CommunicationStyle' });

/**
 * A customer's language settings as the widget sees them (U01, HNV-07-04). The interface locale
 * and the reply language are independent. `confirm` asks the customer once to choose when their
 * messages fit more than one language, such as Hinglish and Roman Urdu.
 */
export const WidgetLanguageState = z
  .object({
    uiLocale: SupportedLocale.nullable(),
    replyLanguage: ReplyLanguage,
    source: z.enum([
      'explicit',
      'detected',
      'decided',
      'suggested',
      'previous',
      'locale',
      'default',
    ]),
    confirm: z
      .object({ suggested: ReplyLanguage, alternatives: z.array(ReplyLanguage) })
      .nullable(),
    style: CommunicationStyle,
  })
  .meta({ id: 'WidgetLanguageState' });
export type WidgetLanguageState = z.infer<typeof WidgetLanguageState>;

export const SetWidgetLanguageRequest = z
  .object({
    /** The customer's own choice of reply language; null clears it. */
    replyLanguage: ReplyLanguage.nullable().optional(),
    uiLocale: SupportedLocale.optional(),
    /** The customer closed the language question without choosing; it is not asked again. */
    dismissPrompt: z.literal(true).optional(),
    style: CommunicationStyle.partial().optional(),
  })
  .meta({ id: 'SetWidgetLanguageRequest' });
export type SetWidgetLanguageRequest = z.input<typeof SetWidgetLanguageRequest>;
