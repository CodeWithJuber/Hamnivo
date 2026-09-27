import type { WidgetConfig } from '@hamnivo/contracts';
import type { schema } from '@hamnivo/db';

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

export function widgetConfig(brand: typeof schema.brands.$inferSelect): WidgetConfig {
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
    // No availability model yet: never claim a person is standing by (W11).
    availability: { humanAvailable: false, nextOpenAt: null, timezone: 'UTC' },
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

export function handoffMessage(locale: string | null | undefined): string {
  const key = (['en', 'ar', 'hi', 'ur'] as const).find((l) => l === locale) ?? 'en';
  return COPY[key].offlineMessage;
}
