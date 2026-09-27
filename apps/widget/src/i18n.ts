import type { ReplyLanguage } from '@hamnivo/contracts';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

/** Widget chrome in the four launch languages (translations await native review). */
export const resources = {
  en: {
    translation: {
      title: 'Chat',
      placeholder: 'Write a message…',
      send: 'Send',
      talkToPerson: 'Talk to a person',
      close: 'Close chat',
      you: 'You',
      waitingForPerson: 'Your request is with the support team.',
      withPerson: 'You are chatting with a person from the team.',
      resolved: 'This conversation is closed. Write to reopen it.',
      reconnecting: 'Reconnecting…',
      offline: 'You are offline. Messages will be sent when you reconnect.',
      sending: 'Sending…',
      notSent: 'Not sent.',
      retry: 'Retry',
      language: 'Language',
      startError: 'The chat could not start. Please try again.',
      typing: 'The assistant is writing…',
      sources: 'Sources',
      languageQuestion: 'Which language should replies use?',
      languageNotNow: 'Not now',
      languageChosen: 'Replies will be in {{language}}.',
    },
  },
  ar: {
    translation: {
      title: 'المحادثة',
      placeholder: 'اكتب رسالة…',
      send: 'إرسال',
      talkToPerson: 'التحدث إلى شخص',
      close: 'إغلاق المحادثة',
      you: 'أنت',
      waitingForPerson: 'طلبك لدى فريق الدعم.',
      withPerson: 'أنت تتحدث مع شخص من الفريق.',
      resolved: 'أُغلقت هذه المحادثة. اكتب لإعادة فتحها.',
      reconnecting: 'جارٍ إعادة الاتصال…',
      offline: 'أنت غير متصل. سترسل الرسائل عند عودة الاتصال.',
      sending: 'جارٍ الإرسال…',
      notSent: 'لم تُرسل.',
      retry: 'إعادة المحاولة',
      language: 'اللغة',
      startError: 'تعذّر بدء المحادثة. حاول مرة أخرى.',
      typing: 'المساعد يكتب…',
      sources: 'المصادر',
      languageQuestion: 'بأي لغة تريد أن تصلك الردود؟',
      languageNotNow: 'ليس الآن',
      languageChosen: 'ستصلك الردود بهذه اللغة: {{language}}.',
    },
  },
  hi: {
    translation: {
      title: 'चैट',
      placeholder: 'संदेश लिखें…',
      send: 'भेजें',
      talkToPerson: 'किसी व्यक्ति से बात करें',
      close: 'चैट बंद करें',
      you: 'आप',
      waitingForPerson: 'आपका अनुरोध सपोर्ट टीम के पास है।',
      withPerson: 'आप टीम के एक व्यक्ति से बात कर रहे हैं।',
      resolved: 'यह बातचीत बंद हो गई है। फिर से खोलने के लिए लिखें।',
      reconnecting: 'फिर से जुड़ रहे हैं…',
      offline: 'आप ऑफ़लाइन हैं। जुड़ते ही संदेश भेज दिए जाएँगे।',
      sending: 'भेजा जा रहा है…',
      notSent: 'नहीं भेजा गया।',
      retry: 'फिर कोशिश करें',
      language: 'भाषा',
      startError: 'चैट शुरू नहीं हो सकी। कृपया फिर कोशिश करें।',
      typing: 'सहायक लिख रहा है…',
      sources: 'स्रोत',
      languageQuestion: 'जवाब किस भाषा में चाहिए?',
      languageNotNow: 'अभी नहीं',
      languageChosen: 'जवाब इस भाषा में आएँगे: {{language}}।',
    },
  },
  ur: {
    translation: {
      title: 'چیٹ',
      placeholder: 'پیغام لکھیں…',
      send: 'بھیجیں',
      talkToPerson: 'کسی شخص سے بات کریں',
      close: 'چیٹ بند کریں',
      you: 'آپ',
      waitingForPerson: 'آپ کی درخواست سپورٹ ٹیم کے پاس ہے۔',
      withPerson: 'آپ ٹیم کے ایک فرد سے بات کر رہے ہیں۔',
      resolved: 'یہ گفتگو بند ہو گئی ہے۔ دوبارہ کھولنے کے لیے لکھیں۔',
      reconnecting: 'دوبارہ جڑ رہے ہیں…',
      offline: 'آپ آف لائن ہیں۔ رابطہ بحال ہوتے ہی پیغامات بھیج دیے جائیں گے۔',
      sending: 'بھیجا جا رہا ہے…',
      notSent: 'نہیں بھیجا گیا۔',
      retry: 'دوبارہ کوشش کریں',
      language: 'زبان',
      startError: 'چیٹ شروع نہیں ہو سکی۔ براہ کرم دوبارہ کوشش کریں۔',
      typing: 'اسسٹنٹ لکھ رہا ہے…',
      sources: 'ذرائع',
      languageQuestion: 'جوابات کس زبان میں چاہییں؟',
      languageNotNow: 'ابھی نہیں',
      languageChosen: 'جوابات اس زبان میں آئیں گے: {{language}}۔',
    },
  },
} as const;

export type Locale = keyof typeof resources;
export const LOCALES: Locale[] = ['en', 'ar', 'hi', 'ur'];
export const RTL = new Set<Locale>(['ar', 'ur']);
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
  ur: 'اردو',
};

/**
 * Reply languages named in themselves, so customers recognise their own. Hinglish and Roman Urdu
 * are Hindi and Urdu written in Latin letters, not English.
 */
export const REPLY_LANGUAGE_NAMES: Record<ReplyLanguage, string> = {
  en: 'English',
  ar: 'العربية',
  hi: 'हिन्दी',
  ur: 'اردو',
  'hi-Latn': 'Hinglish',
  'ur-Latn': 'Roman Urdu',
};

export function pickLocale(requested: string | null | undefined): Locale {
  const base = requested?.toLowerCase().split('-')[0];
  return LOCALES.find((l) => l === base) ?? 'en';
}

export async function initI18n(locale: Locale) {
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return i18next;
}

/** Applies language and direction to the document (RTL for Arabic and Urdu). */
export function applyLocale(locale: Locale) {
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL.has(locale) ? 'rtl' : 'ltr';
}
