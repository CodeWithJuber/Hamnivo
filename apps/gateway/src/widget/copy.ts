import {
  type HandoffResponse,
  type LauncherConfig,
  type LocalizedText,
  ProactiveSettings,
  type WidgetConfig,
  WidgetSettings,
} from '@hamnivo/contracts';
import type { schema } from '@hamnivo/db';
import { isOpen, nextOpening } from '@hamnivo/domain';
import type { BrandSurface } from './settings.service.js';

type Locale = 'en' | 'ar' | 'hi' | 'ur';

/** Default widget copy (design kit §5 microcopy). Tenants override it; translations await native review. */
const COPY: Record<Locale, WidgetConfig['copy'][Locale]> = {
  en: {
    greeting: 'Assalamu alaikum! How can we help today?',
    aiDisclosure: "I'm {brand}'s AI assistant. I can help here, or connect you with a person.",
    offlineMessage:
      'Your request is with the support team. You can keep this chat open or leave a reply address.',
    privacyNotice: null,
  },
  ar: {
    greeting: 'السلام عليكم! كيف يمكننا مساعدتك اليوم؟',
    aiDisclosure: 'أنا المساعد الذكي لدى {brand}. يمكنني المساعدة هنا، أو إيصالك بشخص من الفريق.',
    offlineMessage: 'طلبك لدى فريق الدعم. يمكنك إبقاء هذه المحادثة مفتوحة أو ترك عنوان للرد.',
    privacyNotice: null,
  },
  hi: {
    greeting: 'अस्सलामु अलैकुम! आज हम आपकी क्या मदद कर सकते हैं?',
    aiDisclosure: 'मैं {brand} का एआई सहायक हूँ। मैं यहाँ मदद कर सकता हूँ, या आपको किसी व्यक्ति से जोड़ सकता हूँ।',
    offlineMessage:
      'आपका अनुरोध सपोर्ट टीम के पास है। आप यह चैट खुली रख सकते हैं या जवाब के लिए पता छोड़ सकते हैं।',
    privacyNotice: null,
  },
  ur: {
    greeting: 'السلام علیکم! آج ہم آپ کی کیا مدد کر سکتے ہیں؟',
    aiDisclosure:
      'میں {brand} کا اے آئی اسسٹنٹ ہوں۔ میں یہاں مدد کر سکتا ہوں، یا آپ کو کسی شخص سے ملا سکتا ہوں۔',
    offlineMessage:
      'آپ کی درخواست سپورٹ ٹیم کے پاس ہے۔ آپ یہ چیٹ کھلی رکھ سکتے ہیں یا جواب کے لیے پتہ چھوڑ سکتے ہیں۔',
    privacyNotice: null,
  },
};

/** "People are away" with the time they are back; translations await native review. */
const AWAY: Record<Locale, (when: string) => string> = {
  en: (when) =>
    `Our team is away right now and answers again ${when}. Your messages are kept here, and you can keep chatting with the AI assistant.`,
  ar: (when) =>
    `فريقنا غير متاح الآن ويعود للرد ${when}. رسائلك محفوظة هنا، ويمكنك متابعة الحديث مع المساعد الذكي.`,
  hi: (when) =>
    `हमारी टीम अभी उपलब्ध नहीं है और ${when} फिर से जवाब देगी। आपके संदेश यहाँ सुरक्षित हैं, और आप एआई सहायक से बात जारी रख सकते हैं।`,
  ur: (when) =>
    `ہماری ٹیم ابھی موجود نہیں ہے اور ${when} دوبارہ جواب دے گی۔ آپ کے پیغامات یہاں محفوظ ہیں، اور آپ اے آئی اسسٹنٹ سے بات جاری رکھ سکتے ہیں۔`,
};
const AWAY_UNKNOWN: Record<Locale, string> = {
  en: 'Our team is away right now. Your messages are kept here, and a person will read them.',
  ar: 'فريقنا غير متاح الآن. رسائلك محفوظة هنا، وسيقرؤها شخص من الفريق.',
  hi: 'हमारी टीम अभी उपलब्ध नहीं है। आपके संदेश यहाँ सुरक्षित हैं, और कोई व्यक्ति उन्हें पढ़ेगा।',
  ur: 'ہماری ٹیم ابھی موجود نہیں ہے۔ آپ کے پیغامات یہاں محفوظ ہیں، اور کوئی شخص انہیں پڑھے گا۔',
};

const localeOf = (locale: string | null | undefined): Locale =>
  (['en', 'ar', 'hi', 'ur'] as const).find((l) => l === locale) ?? 'en';

/** Whether people are working now and when they are back, from the brand's hours (W11). */
export function availabilityOf(
  brand: typeof schema.brands.$inferSelect,
  now: Date,
): WidgetConfig['availability'] {
  const hours = brand.businessHours;
  // Without hours there is no way to know: never claim a person is standing by.
  if (!hours) return { humanAvailable: false, nextOpenAt: null, timezone: 'UTC' };
  const open = isOpen(hours, now);
  return {
    humanAvailable: open,
    nextOpenAt: open ? null : (nextOpening(hours, now)?.toISOString() ?? null),
    timezone: hours.timezone,
  };
}

/** Defaults for a brand that has saved no settings. */
export const DEFAULT_SURFACE: BrandSurface = {
  settings: WidgetSettings.parse({}),
  proactive: ProactiveSettings.parse({}),
  settingsUpdatedAt: null,
  proactiveUpdatedAt: null,
};

const LOCALES: Locale[] = ['en', 'ar', 'hi', 'ur'];

/** A brand's text in one language, falling back to its English. */
const textIn = (text: LocalizedText, locale: Locale): string => text[locale] ?? text.en;

export function widgetConfig(
  brand: typeof schema.brands.$inferSelect,
  now: Date = new Date(),
  surface: BrandSurface = DEFAULT_SURFACE,
  /** Files are offered only where they can be scanned (ClamAV in production). */
  options: { filesScannable?: boolean } = {},
): WidgetConfig {
  const theme = brand.theme ?? {};
  const { settings, proactive } = surface;
  const copy = Object.fromEntries(
    (Object.keys(COPY) as Locale[]).map((locale) => [
      locale,
      { ...COPY[locale], aiDisclosure: COPY[locale].aiDisclosure.replace('{brand}', brand.name) },
    ]),
  ) as WidgetConfig['copy'];
  const availability = availabilityOf(brand, now);
  const prompting =
    proactive.enabled && (!proactive.onlyWhenAvailable || availability.humanAvailable);
  return {
    widgetId: brand.widgetPublicId,
    version: brand.configVersion,
    brand: {
      name: brand.name,
      logoUrl: theme.logoUrl ?? null,
      accent: theme.accent ?? '#192A30',
      onAccent: theme.onAccent ?? '#FFFFFF',
      radius: theme.radius ?? 12,
      launcherPosition: settings.layout.position,
    },
    locales: { default: 'en', available: ['en', 'ar', 'hi', 'ur'] },
    copy,
    availability,
    features: {
      attachments: settings.attachments.enabled && options.filesScannable !== false,
      helpCenter: settings.help.search,
      csat: false,
      voice: false,
      identityRequiredForHistory: false,
    },
    privacyPolicyUrl: null,
    attachmentLimits: {
      maxBytes: settings.attachments.maxMegabytes * 1024 * 1024,
      allowedMimeTypes: [...settings.attachments.allowedTypes],
      maxFiles: settings.attachments.maxFiles,
    },
    layout: { mode: settings.layout.mode, position: settings.layout.position },
    help: {
      suggestions: Object.fromEntries(
        LOCALES.map((locale) => [locale, settings.help.suggestions.map((q) => textIn(q, locale))]),
      ) as WidgetConfig['help']['suggestions'],
      search: settings.help.search,
    },
    messageDeletion: { windowSeconds: settings.deletion.windowMinutes * 60 },
    notifications: { email: settings.notifications.email },
    proactive: {
      triggers: prompting
        ? proactive.triggers.map((trigger) => ({
            id: trigger.id,
            kind: trigger.kind,
            message: Object.fromEntries(
              LOCALES.map((locale) => [locale, textIn(trigger.message, locale)]),
            ) as Record<Locale, string>,
          }))
        : [],
    },
  };
}

/** The loader's own words (W01, W02, W19): its button, the chat frame and a prompt's close. */
const LAUNCHER_COPY: Record<Locale, Omit<LauncherConfig['launcher'], 'accent' | 'onAccent'>> = {
  en: {
    openLabel: 'Open chat',
    closeLabel: 'Close chat',
    title: 'Chat',
    dismissLabel: 'Dismiss',
    unreadLabel: '{count} unread',
  },
  ar: {
    openLabel: 'فتح المحادثة',
    closeLabel: 'إغلاق المحادثة',
    title: 'المحادثة',
    dismissLabel: 'تجاهل',
    unreadLabel: '{count} غير مقروءة',
  },
  hi: {
    openLabel: 'चैट खोलें',
    closeLabel: 'चैट बंद करें',
    title: 'चैट',
    dismissLabel: 'हटाएँ',
    unreadLabel: '{count} अपठित',
  },
  ur: {
    openLabel: 'چیٹ کھولیں',
    closeLabel: 'چیٹ بند کریں',
    title: 'چیٹ',
    dismissLabel: 'ہٹائیں',
    unreadLabel: '{count} بغیر پڑھے',
  },
};

/**
 * What the loader needs before the widget loads (W02, W19): the layout, launcher colours and
 * labels, and the proactive prompts in one language. Prompts are only sent while the brand has
 * them on (and, when it asks, while people are working); the loader enforces the caps.
 */
export function launcherConfig(
  brand: typeof schema.brands.$inferSelect,
  surface: BrandSurface,
  locale: string | null | undefined,
  now: Date,
): LauncherConfig {
  const lang = localeOf(locale);
  const config = widgetConfig(brand, now, surface);
  const shown = new Set(config.proactive.triggers.map((t) => t.id));
  return {
    widgetId: brand.widgetPublicId,
    version: brand.configVersion,
    locale: lang,
    dir: lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr',
    layout: config.layout,
    launcher: {
      accent: config.brand.accent,
      onAccent: config.brand.onAccent,
      ...LAUNCHER_COPY[lang],
    },
    proactive: {
      enabled: shown.size > 0,
      maxPerDay: surface.proactive.maxPerDay,
      dismissHours: surface.proactive.dismissHours,
      triggers: surface.proactive.triggers
        .filter((t) => shown.has(t.id))
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          path: t.path,
          seconds: t.seconds,
          visits: t.visits,
          message: textIn(t.message, lang),
        })),
    },
  };
}

/**
 * The honest answer to "talk to a person" (W11, R12): queued while people work, otherwise away,
 * with when they are back in the customer's language and the brand's time zone.
 */
export function handoffOutcome(
  brand: typeof schema.brands.$inferSelect | undefined,
  locale: string | null | undefined,
  now: Date,
): Pick<HandoffResponse, 'availability' | 'message' | 'followUp'> {
  const lang = localeOf(locale);
  const hours = brand?.businessHours;
  if (!hours || isOpen(hours, now)) {
    return { availability: 'queued', message: COPY[lang].offlineMessage, followUp: null };
  }
  const back = nextOpening(hours, now);
  if (!back) {
    return { availability: 'offline', message: AWAY_UNKNOWN[lang], followUp: null };
  }
  const when = new Intl.DateTimeFormat(lang, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: hours.timezone,
    timeZoneName: 'short',
  }).format(back);
  return {
    availability: 'offline',
    message: AWAY[lang](when),
    followUp: { channel: 'this_chat', expectedBy: back.toISOString() },
  };
}
