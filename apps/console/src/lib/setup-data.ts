/**
 * Facts about setup that Studio shows as they are, kept here as plain data. The same lists are
 * in `@hamnivo/contracts`, where the gateway checks them; Studio imports only the types from
 * there so the schema library stays out of the page, and `test/setup.test.ts` fails when the two
 * lists drift apart.
 */
import type { KeyedProvider, ModelOption, OnboardingStep } from '@hamnivo/contracts';

/** The dropdown's last entry: the person types the model name themselves. */
export const CUSTOM_MODEL = 'custom';

/** The models offered per provider. An OpenAI-compatible server has none: each names its own. */
export const MODEL_CATALOG: Readonly<Record<KeyedProvider, readonly ModelOption[]>> = {
  anthropic: [
    { id: 'claude-haiku-4-5', tier: 'fast', recommended: true },
    { id: 'claude-sonnet-5', tier: 'balanced' },
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

/** The dropdown value for a stored model name: the name when it is listed, `custom` otherwise. */
export function modelDropdownValue(provider: KeyedProvider, modelId: string): string {
  return MODEL_CATALOG[provider].some((model) => model.id === modelId) ? modelId : CUSTOM_MODEL;
}

export type ChatLanguage = 'en' | 'ar' | 'hi' | 'ur';

/** What the chat says until a brand writes its own words (the preview shows what customers read). */
export const DEFAULT_WIDGET_TEXT: Readonly<
  Record<'greeting' | 'away' | 'awayUnknown', Readonly<Record<ChatLanguage, string>>>
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
};

/**
 * Words drawn inside the live preview, in the customer's language: what the chat's own text box,
 * rating and privacy link say. An illustration; the real chat has the real words.
 */
export const PREVIEW_TEXT: Readonly<
  Record<ChatLanguage, { placeholder: string; question: string; rating: string; privacy: string }>
> = {
  en: {
    placeholder: 'Write a message…',
    question: 'Where is my order?',
    rating: 'How was this chat?',
    privacy: 'Privacy policy',
  },
  ar: {
    placeholder: 'اكتب رسالة…',
    question: 'أين طلبي؟',
    rating: 'كيف كانت هذه المحادثة؟',
    privacy: 'سياسة الخصوصية',
  },
  hi: {
    placeholder: 'संदेश लिखें…',
    question: 'मेरा ऑर्डर कहाँ है?',
    rating: 'यह बातचीत कैसी रही?',
    privacy: 'गोपनीयता नीति',
  },
  ur: {
    placeholder: 'پیغام لکھیں…',
    question: 'میرا آرڈر کہاں ہے؟',
    rating: 'یہ گفتگو کیسی رہی؟',
    privacy: 'پرائیویسی پالیسی',
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
