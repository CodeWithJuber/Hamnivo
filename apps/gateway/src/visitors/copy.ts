/**
 * The line the chat shows when a website notes which pages visitors view (translations await
 * native review, like the rest of the widget's words).
 */
const NOTICE = {
  en: 'To help you, this website notes which pages you view. Turn on Do Not Track in your browser to opt out.',
  ar: 'لمساعدتك، يسجّل هذا الموقع الصفحات التي تتصفحها. فعّل خيار «عدم التتبع» في متصفحك لإيقاف ذلك.',
  hi: 'आपकी मदद के लिए यह वेबसाइट दर्ज करती है कि आप कौन-से पेज देखते हैं। इसे बंद करने के लिए अपने ब्राउज़र में “Do Not Track” चालू करें।',
  ur: 'آپ کی مدد کے لیے یہ ویب سائٹ نوٹ کرتی ہے کہ آپ کون سے صفحات دیکھتے ہیں۔ اسے بند کرنے کے لیے اپنے براؤزر میں “Do Not Track” آن کریں۔',
} as const;

type Locale = keyof typeof NOTICE;

export const visitorNotice = (locale: string | null | undefined): string =>
  NOTICE[(locale?.split('-')[0] as Locale | undefined) ?? 'en'] ?? NOTICE.en;
