import type { HandoffResponse, WidgetConfig } from '@hamnivo/contracts';
import type { schema } from '@hamnivo/db';
import { isOpen, nextOpening } from '@hamnivo/domain';

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

export function widgetConfig(
  brand: typeof schema.brands.$inferSelect,
  now: Date = new Date(),
): WidgetConfig {
  const theme = brand.theme ?? {};
  const copy = Object.fromEntries(
    (Object.keys(COPY) as Locale[]).map((locale) => [
      locale,
      { ...COPY[locale], aiDisclosure: COPY[locale].aiDisclosure.replace('{brand}', brand.name) },
    ]),
  ) as WidgetConfig['copy'];
  return {
    widgetId: brand.widgetPublicId,
    version: brand.configVersion,
    brand: {
      name: brand.name,
      logoUrl: theme.logoUrl ?? null,
      accent: theme.accent ?? '#192A30',
      onAccent: theme.onAccent ?? '#FFFFFF',
      radius: theme.radius ?? 12,
      launcherPosition: theme.launcherPosition ?? 'bottom-right',
    },
    locales: { default: 'en', available: ['en', 'ar', 'hi', 'ur'] },
    copy,
    availability: availabilityOf(brand, now),
    features: {
      attachments: false,
      helpCenter: false,
      csat: false,
      voice: false,
      identityRequiredForHistory: false,
    },
    privacyPolicyUrl: null,
    attachmentLimits: {
      maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'],
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
