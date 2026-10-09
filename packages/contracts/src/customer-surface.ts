import { z } from 'zod';
import { ClientMessageId, SupportedLocale, Timestamp } from './common.js';
import { ReactionEmoji } from './parts.js';

/**
 * The customer surface of the widget beyond the conversation itself: how the chat sits on the
 * page (W02), files (W09), help before a conversation (W17), proactive prompts (W19), message
 * deletion (W23), reactions (W22) and email notifications (W25).
 */

/**
 * How the chat sits on the website (W02): a floating launcher (`bubble`), a side `panel`, `inline`
 * in an element of the page, or the whole page (`fullpage`). Each brand chooses one; the loader's
 * `data-mode` overrides it. On narrow screens the bubble and the panel open full screen.
 */
export const WidgetLayoutMode = z.enum(['bubble', 'panel', 'inline', 'fullpage']);
export type WidgetLayoutMode = z.infer<typeof WidgetLayoutMode>;

export const LauncherSide = z.enum(['bottom-right', 'bottom-left']);

/** Text a brand writes in each language; English is required and the others fall back to it. */
export const LocalizedText = (max: number) =>
  z.object({
    en: z.string().trim().min(1).max(max),
    ar: z.string().trim().min(1).max(max).optional(),
    hi: z.string().trim().min(1).max(max).optional(),
    ur: z.string().trim().min(1).max(max).optional(),
  });
export type LocalizedText = z.infer<ReturnType<typeof LocalizedText>>;

/** File types a customer may send (W09). Detected from the bytes; SVG and archives never pass. */
export const ATTACHMENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;
export const AttachmentType = z.enum(ATTACHMENT_TYPES);
export type AttachmentType = z.infer<typeof AttachmentType>;
/** The largest file any brand may accept. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
/** The most files one message may carry. */
export const ATTACHMENT_MAX_FILES = 5;

/** A brand's widget settings (widget.configure). */
export const WidgetSettings = z
  .object({
    layout: z
      .object({
        mode: WidgetLayoutMode.default('bubble'),
        position: LauncherSide.default('bottom-right'),
      })
      .prefault({}),
    attachments: z
      .object({
        enabled: z.boolean().default(true),
        allowedTypes: z
          .array(AttachmentType)
          .min(1)
          .default([...ATTACHMENT_TYPES]),
        maxMegabytes: z.int().min(1).max(10).default(10),
        maxFiles: z.int().min(1).max(ATTACHMENT_MAX_FILES).default(ATTACHMENT_MAX_FILES),
      })
      .prefault({}),
    help: z
      .object({
        /** Questions offered on the widget's home screen, in the brand's words. */
        suggestions: z.array(LocalizedText(120)).max(6).default([]),
        /** Search of the brand's public knowledge before a conversation starts. */
        search: z.boolean().default(true),
      })
      .prefault({}),
    deletion: z
      .object({
        /** How long after sending a customer may delete a message; 0 turns deleting off. */
        windowMinutes: z.int().min(0).max(60).default(10),
      })
      .prefault({}),
    notifications: z
      .object({
        /** Offer verified customers transcript and reply-waiting emails. */
        email: z.boolean().default(true),
      })
      .prefault({}),
  })
  .meta({ id: 'WidgetSettings' });
export type WidgetSettings = z.infer<typeof WidgetSettings>;

export const UpdateWidgetSettingsRequest = WidgetSettings.meta({
  id: 'UpdateWidgetSettingsRequest',
});

export const WidgetSettingsView = z
  .object({
    brandId: z.string(),
    settings: WidgetSettings,
    /** The published configuration version the widget sees. */
    configVersion: z.int().positive(),
  })
  .meta({ id: 'WidgetSettingsView' });
export type WidgetSettingsView = z.infer<typeof WidgetSettingsView>;

/** What started a proactive prompt in W19; kept only to describe the retired `triggers` list. */
export const ProactiveTriggerKind = z.enum(['page_path', 'time_on_page', 'returning_visitor']);
export type ProactiveTriggerKind = z.infer<typeof ProactiveTriggerKind>;

/**
 * Website prompts' limits for a brand (stored as `brand_widget_settings.proactive`). The prompts
 * themselves are website automations (G21). The bounds mean no configuration can show a visitor
 * more than three prompts a day.
 */
export const PromptLimits = z
  .object({
    /** Prompts one visitor may see in a day (1–3). */
    maxPerDay: z.int().min(1).max(3).default(1),
    /** After a visitor dismisses a prompt, none for this many hours (1 hour to 7 days). */
    dismissHours: z.int().min(1).max(168).default(24),
  })
  .meta({ id: 'PromptLimits' });
export type PromptLimits = z.infer<typeof PromptLimits>;

/**
 * A condition the loader checks in the visitor's browser, as `[field, operator, value]`: the page
 * address or referrer (contains, starts_with, is, not_contains), visits so far (at_least,
 * at_most) or the device from the window's width (is, is_not).
 */
export const BrowserCondition = z.union([
  z.tuple([
    z.enum(['page_url', 'referrer']),
    z.enum(['contains', 'starts_with', 'is', 'not_contains']),
    z.string(),
  ]),
  z.tuple([z.literal('visit_count'), z.enum(['at_least', 'at_most']), z.int()]),
  z.tuple([z.literal('device'), z.enum(['is', 'is_not']), z.array(z.string())]),
]);
export type BrowserCondition = z.infer<typeof BrowserCondition>;

/**
 * What the loader needs before the widget loads (public; the widget ID is not a secret): the
 * layout, launcher colours and labels, and the proactive prompts in the requested language.
 */
export const LauncherConfig = z
  .object({
    widgetId: z.string(),
    version: z.int().positive(),
    locale: SupportedLocale,
    dir: z.enum(['ltr', 'rtl']),
    layout: z.object({ mode: WidgetLayoutMode, position: LauncherSide }),
    launcher: z.object({
      accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      onAccent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      openLabel: z.string().max(80),
      closeLabel: z.string().max(80),
      title: z.string().max(80),
      dismissLabel: z.string().max(80),
      /** "{count} unread" in the requested language. */
      unreadLabel: z.string().max(80),
    }),
    proactive: z.object({
      enabled: z.boolean(),
      maxPerDay: z.int(),
      dismissHours: z.int(),
      /** Retired with W19's triggers; always empty, so loaders from before G21 show nothing. */
      triggers: z.array(
        z.object({
          id: z.string(),
          kind: ProactiveTriggerKind,
          path: z.string().nullable(),
          seconds: z.int(),
          visits: z.int().nullable(),
          message: z.string(),
        }),
      ),
      /**
       * Website automations that may prompt this visitor (G21), in the brand's order. The gateway
       * already checked what it knows (country, language, hours, who is online); `when` is left
       * for the browser: all of it, or one of it when `any`.
       */
      rules: z.array(
        z.object({
          id: z.string(),
          /** Seconds on the page before the prompt shows. */
          seconds: z.int(),
          any: z.boolean(),
          when: z.array(BrowserCondition),
          message: z.string(),
        }),
      ),
    }),
  })
  .meta({ id: 'LauncherConfig' });
export type LauncherConfig = z.infer<typeof LauncherConfig>;

/** One help result from the brand's public knowledge (W17), shown before any conversation. */
export const HelpArticle = z
  .object({
    id: z.string(),
    title: z.string().max(300),
    heading: z.string().max(300).nullable(),
    excerpt: z.string().max(600),
    url: z.url().nullable(),
    version: z.int().nonnegative(),
  })
  .meta({ id: 'HelpArticle' });
export type HelpArticle = z.infer<typeof HelpArticle>;

export const HelpSearchResponse = z
  .object({ query: z.string(), items: z.array(HelpArticle) })
  .meta({ id: 'HelpSearchResponse' });
export type HelpSearchResponse = z.infer<typeof HelpSearchResponse>;

/** Result of deleting one's own message (W23). */
export const MessageDeletion = z
  .object({ messageId: z.string(), deletedAt: Timestamp })
  .meta({ id: 'MessageDeletion' });
export type MessageDeletion = z.infer<typeof MessageDeletion>;

export const ReactionRequest = z
  .object({ clientMessageId: ClientMessageId, emoji: ReactionEmoji })
  .meta({ id: 'ReactionRequest' });

/** Email notifications a verified customer can choose (W25). */
export const NotificationPreferences = z
  .object({
    /** Emails need a verified customer with a verified address, and a brand that offers them. */
    available: z.boolean(),
    reason: z.enum(['not_verified', 'no_verified_email', 'turned_off_by_brand']).nullable(),
    /** The address emails go to, partly hidden (f•••@example.com). */
    email: z.string().nullable(),
    /** A transcript of the conversation when it is closed. */
    transcript: z.boolean(),
    /** An email when a reply waits and the customer has not seen it. */
    replyWaiting: z.boolean(),
  })
  .meta({ id: 'NotificationPreferences' });
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

export const UpdateNotificationPreferencesRequest = z
  .object({ transcript: z.boolean().optional(), replyWaiting: z.boolean().optional() })
  .refine((v) => v.transcript !== undefined || v.replyWaiting !== undefined, {
    message: 'Send transcript, replyWaiting or both',
  })
  .meta({ id: 'UpdateNotificationPreferencesRequest' });

export const UnsubscribeQuery = z.object({
  token: z
    .string()
    .min(20)
    .max(1024)
    .meta({ description: 'Signed unsubscribe token from the email' }),
});
