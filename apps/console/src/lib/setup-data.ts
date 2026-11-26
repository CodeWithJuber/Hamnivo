/**
 * Facts about setup that Studio shows as they are, kept here as plain data. The same lists are
 * in `@hamnivo/contracts`, where the gateway checks them; Studio imports only the types from
 * there so the schema library stays out of the page, and `test/setup.test.ts` fails when the two
 * lists drift apart.
 */
import type { KeyedProvider, ModelOption, OnboardingStep } from '@hamnivo/contracts';

/**
 * The models suggested per provider when its live list cannot be read, and the words on the
 * recommended one in a live list. An OpenAI-compatible server has none: each names its own.
 */
export const MODEL_CATALOG: Readonly<Record<KeyedProvider, readonly ModelOption[]>> = {
  anthropic: [
    { id: 'claude-haiku-5-5', tier: 'fast', recommended: true },
    { id: 'claude-sonnet-5-5', tier: 'balanced' },
    { id: 'claude-opus-5-5', tier: 'capable' },
  ],
  openai: [
    { id: 'gpt-5.4-mini', tier: 'fast', recommended: true },
    { id: 'gpt-5.4', tier: 'balanced' },
    { id: 'gpt-5.5', tier: 'capable' },
  ],
  google: [
    { id: 'gemini-3.8-flash', tier: 'fast', recommended: true },
    { id: 'gemini-3.5-flash-lite', tier: 'fast' },
    { id: 'gemini-2.5-pro', tier: 'capable' },
  ],
  'openai-compatible': [],
};

/** The model to start with for a provider, or null where each server names its own. */
export function recommendedModel(provider: KeyedProvider): string | null {
  return MODEL_CATALOG[provider].find((model) => model.recommended)?.id ?? null;
}

export type ChatLanguage = 'en' | 'ar' | 'hi' | 'ur';

/** What the chat says until a brand writes its own words (the preview shows what customers read). */
export const DEFAULT_WIDGET_TEXT: Readonly<
  Record<
    'greeting' | 'away' | 'awayUnknown' | 'consent' | 'offlineThanks',
    Readonly<Record<ChatLanguage, string>>
  >
> = {
  greeting: {
    en: 'Assalamu alaikum! How can we help today?',
    ar: 'السلام عليكم! كيف يمكننا مساعدتك اليوم؟',
    hi: 'अस्सलामु अलैकुम! आज हम आपकी क्या मदद कर सकते हैं?',
    ur: 'السلام علیکم! آج ہم آپ کی کیا مدد کر سکتے ہیں؟',
  },
  away: {
    en: 'Our team is away right now and answers again {when}. Your messages are kept here, and you can keep chatting with the AI assistant.',
    ar: 'فريقنا غير متاح الآن ويعود للرد {when}. رسائلك محفوظة هنا، ويمكنك متابعة الحديث مع المساعد الذكي.',
    hi: 'हमारी टीम अभी उपलब्ध नहीं है और {when} फिर से जवाब देगी। आपके संदेश यहाँ सुरक्षित हैं, और आप एआई सहायक से बात जारी रख सकते हैं।',
    ur: 'ہماری ٹیم ابھی موجود نہیں ہے اور {when} دوبارہ جواب دے گی۔ آپ کے پیغامات یہاں محفوظ ہیں، اور آپ اے آئی اسسٹنٹ سے بات جاری رکھ سکتے ہیں۔',
  },
  awayUnknown: {
    en: 'Our team is away right now. Your messages are kept here, and a person will read them.',
    ar: 'فريقنا غير متاح الآن. رسائلك محفوظة هنا، وسيقرؤها شخص من الفريق.',
    hi: 'हमारी टीम अभी उपलब्ध नहीं है। आपके संदेश यहाँ सुरक्षित हैं, और कोई व्यक्ति उन्हें पढ़ेगा।',
    ur: 'ہماری ٹیم ابھی موجود نہیں ہے۔ آپ کے پیغامات یہاں محفوظ ہیں، اور کوئی شخص انہیں پڑھے گا۔',
  },
  consent: {
    en: '{brand} keeps this chat, and what you share in it, so the team can help you. You can ask for it to be deleted at any time.',
    ar: 'تحتفظ {brand} بهذه المحادثة وبما تشاركه فيها حتى يتمكن الفريق من مساعدتك. يمكنك طلب حذفها في أي وقت.',
    hi: '{brand} यह चैट और इसमें आपकी साझा की गई बातें रखता है, ताकि टीम आपकी मदद कर सके। आप कभी भी इसे हटाने के लिए कह सकते हैं।',
    ur: '{brand} یہ چیٹ اور اس میں آپ کی بتائی گئی باتیں محفوظ رکھتا ہے تاکہ ٹیم آپ کی مدد کر سکے۔ آپ کسی بھی وقت اسے حذف کرنے کا کہہ سکتے ہیں۔',
  },
  offlineThanks: {
    en: 'Thank you. Your message is with our team, and we answer messages in the order they arrive.',
    ar: 'شكرًا لك. رسالتك لدى فريقنا، ونرد على الرسائل بحسب ترتيب وصولها.',
    hi: 'धन्यवाद। आपका संदेश हमारी टीम के पास है, और हम संदेशों का जवाब उसी क्रम में देते हैं जिसमें वे आते हैं।',
    ur: 'شکریہ۔ آپ کا پیغام ہماری ٹیم کے پاس ہے، اور ہم پیغامات کا جواب اسی ترتیب سے دیتے ہیں جس میں وہ آتے ہیں۔',
  },
};

/**
 * What the chat's forms say until a brand writes its own words: the consent question (W27) and
 * the thank-you after the contact form (W11). They are the gateway's own words (kept equal to the
 * contracts' by test/setup.test.ts), so the placeholder and the preview show what customers will read. `{brand}` in the
 * consent words is the brand's name.
 */
export const DEFAULT_FORM_TEXT: Readonly<
  Record<'consent' | 'thanks', Readonly<Record<ChatLanguage, string>>>
> = { consent: DEFAULT_WIDGET_TEXT.consent, thanks: DEFAULT_WIDGET_TEXT.offlineThanks };

/** The chat's own words drawn inside the live preview, in one language. */
export interface PreviewWords {
  placeholder: string;
  question: string;
  rating: string;
  privacy: string;
  /** Above the pre-chat form. */
  prechatIntro: string;
  /** Above the contact form while nobody can answer. */
  offlineIntro: string;
  startChat: string;
  send: string;
  agree: string;
  /** After a field that may be left empty. */
  optional: string;
  /** In a list nobody has picked from yet. */
  choose: string;
  /** A sample ticket reference after the contact form is sent. */
  reference: string;
}

/**
 * Words drawn inside the live preview, in the customer's language: what the chat's own text box,
 * rating, privacy link, forms and buttons say. An illustration; the real chat has the real words.
 */
export const PREVIEW_TEXT: Readonly<Record<ChatLanguage, PreviewWords>> = {
  en: {
    placeholder: 'Write a message…',
    question: 'Where is my order?',
    rating: 'How was this chat?',
    privacy: 'Privacy policy',
    prechatIntro: 'Before we start, tell us a little about you.',
    offlineIntro: 'Nobody can answer right now. Leave a message and we will email you back.',
    startChat: 'Start chat',
    send: 'Send message',
    agree: 'I agree',
    optional: 'optional',
    choose: 'Choose…',
    reference: 'Reference #1042',
  },
  ar: {
    placeholder: 'اكتب رسالة…',
    question: 'أين طلبي؟',
    rating: 'كيف كانت هذه المحادثة؟',
    privacy: 'سياسة الخصوصية',
    prechatIntro: 'قبل أن نبدأ، أخبرنا قليلًا عنك.',
    offlineIntro: 'لا أحد متاح للرد الآن. اترك رسالة وسنرد عليك عبر البريد الإلكتروني.',
    startChat: 'ابدأ المحادثة',
    send: 'أرسل الرسالة',
    agree: 'أوافق',
    optional: 'اختياري',
    choose: 'اختر…',
    reference: 'المرجع #1042',
  },
  hi: {
    placeholder: 'संदेश लिखें…',
    question: 'मेरा ऑर्डर कहाँ है?',
    rating: 'यह बातचीत कैसी रही?',
    privacy: 'गोपनीयता नीति',
    prechatIntro: 'शुरू करने से पहले, हमें अपने बारे में थोड़ा बताएँ।',
    offlineIntro: 'अभी कोई जवाब देने के लिए उपलब्ध नहीं है। संदेश छोड़ें, हम आपको ईमेल से जवाब देंगे।',
    startChat: 'चैट शुरू करें',
    send: 'संदेश भेजें',
    agree: 'मैं सहमत हूँ',
    optional: 'वैकल्पिक',
    choose: 'चुनें…',
    reference: 'संदर्भ #1042',
  },
  ur: {
    placeholder: 'پیغام لکھیں…',
    question: 'میرا آرڈر کہاں ہے؟',
    rating: 'یہ گفتگو کیسی رہی؟',
    privacy: 'پرائیویسی پالیسی',
    prechatIntro: 'شروع کرنے سے پہلے، ہمیں اپنے بارے میں تھوڑا بتائیں۔',
    offlineIntro:
      'ابھی کوئی جواب دینے کے لیے موجود نہیں ہے۔ پیغام چھوڑیں، ہم آپ کو ای میل سے جواب دیں گے۔',
    startChat: 'چیٹ شروع کریں',
    send: 'پیغام بھیجیں',
    agree: 'میں متفق ہوں',
    optional: 'اختیاری',
    choose: 'منتخب کریں…',
    reference: 'حوالہ #1042',
  },
};

/** The setup wizard's steps, in order. */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'workspace',
  'brand',
  'engine',
  'aikey',
  'testchat',
  'install',
  'team',
];

/** The default main colour and corner radius of a chat (ink from the brand palette, 12 px). */
export const DEFAULT_PRIMARY_COLOR = '#192A30';
export const DEFAULT_RADIUS = 12;
