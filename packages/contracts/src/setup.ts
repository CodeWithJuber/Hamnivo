import { z } from 'zod';
import { Timestamp } from './common.js';
import { LocalizedText } from './customer-surface.js';
import { typeId } from './ids.js';

/**
 * What a business owner sets up from Studio alone: AI keys and a test of each (A06, G02), how the
 * chat looks and what it says (W03), the test chat, and the setup wizard (A01).
 */

// ── AI keys ───────────────────────────────────────────────────────────────────────────────────

/** Providers that take a key. `mock` needs none and is never offered here. */
export const KeyedProvider = z
  .enum(['anthropic', 'openai', 'google', 'openai-compatible'])
  .meta({ id: 'KeyedProvider' });
export type KeyedProvider = z.infer<typeof KeyedProvider>;

export interface ModelOption {
  /** The provider's own model name, exactly as agents and the provider use it. */
  id: string;
  /** What it is good for, in a word: Studio words it in each language. */
  tier: 'fast' | 'balanced' | 'capable';
  /** The one to start with when a person has no preference. */
  recommended?: true;
}

/**
 * The models Studio offers in its dropdown, per provider. Each name is one the provider's SDK
 * lists today. The list only saves typing: a model that is not on it is entered as "custom", and
 * an OpenAI-compatible server has no list because each one names its own models.
 */
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

/** The dropdown's last entry: the person types the model name themselves. */
export const CUSTOM_MODEL = 'custom';

/** The model to start with for a provider, or null where each server names its own. */
export function recommendedModel(provider: KeyedProvider): string | null {
  return MODEL_CATALOG[provider].find((model) => model.recommended)?.id ?? null;
}

/** The dropdown value for a stored model name: the name when it is listed, `custom` otherwise. */
export function modelDropdownValue(provider: KeyedProvider, modelId: string): string {
  return MODEL_CATALOG[provider].some((model) => model.id === modelId) ? modelId : CUSTOM_MODEL;
}

/** What one test call found out. `ok` is the only success; every other kind has a plain message. */
export const ModelProbeKind = z
  .enum([
    'ok',
    'wrong_key',
    'no_credit',
    'model_not_found',
    'network',
    'blocked',
    'rate_limited',
    'unavailable',
    'unknown',
  ])
  .meta({ id: 'ModelProbeKind' });
export type ModelProbeKind = z.infer<typeof ModelProbeKind>;

/** The words for a person (English), per result. Studio shows its own translation of each. */
export const MODEL_PROBE_MESSAGES: Readonly<Record<ModelProbeKind, string>> = {
  ok: 'The key works. The AI answered our test message.',
  wrong_key:
    'The provider did not accept this key. Check that you copied all of it and that it belongs to this provider.',
  no_credit:
    'The key is real, but the account has no credit left. Add credit with the provider, then test again.',
  model_not_found:
    'The provider does not know this model name. Pick another model from the list, or check the spelling.',
  network:
    'We could not reach the provider. If you set a server address, check it, then try again in a minute.',
  blocked:
    'This server address is not allowed. Use a public https:// address, or ask whoever runs your Hamnivo server.',
  rate_limited: 'The provider is asking us to slow down. Wait a minute and test again.',
  unavailable: 'The provider is having trouble right now. Try again in a few minutes.',
  unknown:
    'The test did not work and we do not know why. Try again, or check the key and the model with the provider.',
};

export const TestModelConnectionRequest = z
  .object({
    /** The model to call. Default: the connection's first allowed model, or the provider's recommended one. */
    modelId: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'TestModelConnectionRequest' });

/** The outcome of one real call of a few tokens. It never carries the key or the provider's own text. */
export const ModelProbeResult = z
  .object({
    ok: z.boolean(),
    kind: ModelProbeKind,
    message: z.string(),
    modelId: z.string(),
    latencyMs: z.int().nonnegative(),
    testedAt: Timestamp,
  })
  .meta({ id: 'ModelProbeResult' });
export type ModelProbeResult = z.infer<typeof ModelProbeResult>;

/** Replaces the key of a connection in place; agents that use it keep working with the new key. */
export const ReplaceModelKeyRequest = z
  .object({ apiKey: z.string().trim().min(8).max(1000) })
  .meta({ id: 'ReplaceModelKeyRequest' });

export const ModelConnectionTest = z
  .object({
    connectionId: typeId('modelConnection'),
    ok: z.boolean(),
    kind: ModelProbeKind,
    modelId: z.string(),
    testedAt: Timestamp,
  })
  .meta({ id: 'ModelConnectionTest' });
export type ModelConnectionTest = z.infer<typeof ModelConnectionTest>;

/** Which keys the server itself holds, as yes or no. A key's value is never sent anywhere. */
export const ServerKeys = z
  .object({
    anthropic: z.boolean(),
    openai: z.boolean(),
    google: z.boolean(),
    openaiCompatible: z.boolean(),
  })
  .meta({ id: 'ServerKeys' });
export type ServerKeys = z.infer<typeof ServerKeys>;

export const ModelSetupStatus = z
  .object({
    serverKeys: ServerKeys,
    /** Whether Jev (the routing and check provider) has a key on this server. */
    jev: z.object({ configured: z.boolean() }),
    /** What searches the knowledge: `mock` is a word matcher for trying things out, not real search. */
    embeddings: z.object({
      provider: z.enum(['mock', 'openai', 'google', 'openai-compatible']),
      ready: z.boolean(),
    }),
    /** The last test of each connection that has one. */
    tests: z.array(ModelConnectionTest),
  })
  .meta({ id: 'ModelSetupStatus' });
export type ModelSetupStatus = z.infer<typeof ModelSetupStatus>;

// ── How the chat looks and what it says ───────────────────────────────────────────────────────

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour such as #192A30');

/** An https address with no user name or password in it. */
const HttpsUrl = z
  .url({ protocol: /^https$/ })
  .max(500)
  .refine(
    (value) => {
      const url = new URL(value);
      return !url.username && !url.password;
    },
    { message: 'The address must not contain a user name or password' },
  );

/**
 * The words the chat uses until a brand writes its own, in each language (translations await
 * native review). One list for the gateway and for Studio's live preview, so the preview shows
 * what customers will read.
 */
export const DEFAULT_WIDGET_TEXT = {
  greeting: {
    en: 'Assalamu alaikum! How can we help today?',
    ar: 'السلام عليكم! كيف يمكننا مساعدتك اليوم؟',
    hi: 'अस्सलामु अलैकुम! आज हम आपकी क्या मदद कर सकते हैं?',
    ur: 'السلام علیکم! آج ہم آپ کی کیا مدد کر سکتے ہیں؟',
  },
  /** Nobody is online. `{when}` is the time people are back. */
  away: {
    en: 'Our team is away right now and answers again {when}. Your messages are kept here, and you can keep chatting with the AI assistant.',
    ar: 'فريقنا غير متاح الآن ويعود للرد {when}. رسائلك محفوظة هنا، ويمكنك متابعة الحديث مع المساعد الذكي.',
    hi: 'हमारी टीम अभी उपलब्ध नहीं है और {when} फिर से जवाब देगी। आपके संदेश यहाँ सुरक्षित हैं, और आप एआई सहायक से बात जारी रख सकते हैं।',
    ur: 'ہماری ٹیم ابھی موجود نہیں ہے اور {when} دوبارہ جواب دے گی۔ آپ کے پیغامات یہاں محفوظ ہیں، اور آپ اے آئی اسسٹنٹ سے بات جاری رکھ سکتے ہیں۔',
  },
  /** Nobody is online and nobody knows when people are back. */
  awayUnknown: {
    en: 'Our team is away right now. Your messages are kept here, and a person will read them.',
    ar: 'فريقنا غير متاح الآن. رسائلك محفوظة هنا، وسيقرؤها شخص من الفريق.',
    hi: 'हमारी टीम अभी उपलब्ध नहीं है। आपके संदेश यहाँ सुरक्षित हैं, और कोई व्यक्ति उन्हें पढ़ेगा।',
    ur: 'ہماری ٹیم ابھی موجود نہیں ہے۔ آپ کے پیغامات یہاں محفوظ ہیں، اور کوئی شخص انہیں پڑھے گا۔',
  },
} as const satisfies Record<string, Record<'en' | 'ar' | 'hi' | 'ur', string>>;

/** The default main colour: ink from the brand palette. */
export const DEFAULT_PRIMARY_COLOR = '#192A30';
/** The default corner radius, in pixels. */
export const DEFAULT_RADIUS = 12;

/**
 * How a brand's chat looks and what it says (W03). Words left out (`null`) are Hamnivo's own, in
 * every language; words given are the brand's, and a language left empty shows the English.
 */
export const WidgetAppearance = z
  .object({
    /** The main colour: header, send button and launcher. Text on it is chosen to be readable. */
    primaryColor: HexColor.default(DEFAULT_PRIMARY_COLOR),
    logoUrl: HttpsUrl.nullable().default(null),
    /** How round the corners are, 0 to 24 pixels. */
    radius: z.int().min(0).max(24).default(DEFAULT_RADIUS),
    greeting: LocalizedText(300).nullable().default(null),
    /** What customers read when nobody on the team is online. `{when}` becomes the time people are back. */
    offlineText: LocalizedText(300).nullable().default(null),
    /** Ask customers for a 1 to 5 rating when a chat is closed. */
    csat: z.boolean().default(false),
    privacyUrl: HttpsUrl.nullable().default(null),
  })
  .meta({ id: 'WidgetAppearance' });
export type WidgetAppearance = z.infer<typeof WidgetAppearance>;

export const UpdateWidgetAppearanceRequest = WidgetAppearance.meta({
  id: 'UpdateWidgetAppearanceRequest',
});

export const WidgetAppearanceView = z
  .object({
    brandId: typeId('brand'),
    appearance: WidgetAppearance,
    /** The configuration version the widget sees after this save. */
    configVersion: z.int().positive(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'WidgetAppearanceView' });
export type WidgetAppearanceView = z.infer<typeof WidgetAppearanceView>;

// ── The setup wizard ──────────────────────────────────────────────────────────────────────────

/** The wizard's steps, in order. */
export const ONBOARDING_STEPS = [
  'workspace',
  'brand',
  'engine',
  'aikey',
  'testchat',
  'install',
  'team',
] as const;
export const OnboardingStep = z.enum(ONBOARDING_STEPS).meta({ id: 'OnboardingStep' });
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const OnboardingStepState = z.enum(['done', 'skipped']).meta({ id: 'OnboardingStepState' });

/** Where the owner is in setup. A step that is not listed has not been dealt with yet. */
export const OnboardingProgress = z
  .object({
    steps: z.partialRecord(OnboardingStep, OnboardingStepState),
    /** The brand the wizard is working on, once there is one. */
    brandId: typeId('brand').nullable(),
    finishedAt: Timestamp.nullable(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: 'OnboardingProgress' });
export type OnboardingProgress = z.infer<typeof OnboardingProgress>;

/** Changes some steps (`null` takes a step back to "not yet"), the brand, or finishes the wizard. */
export const UpdateOnboardingRequest = z
  .object({
    steps: z.partialRecord(OnboardingStep, OnboardingStepState.nullable()).optional(),
    brandId: typeId('brand').nullable().optional(),
    finished: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.steps !== undefined || value.brandId !== undefined || value.finished !== undefined,
    { message: 'Send steps, a brand or finished' },
  )
  .meta({ id: 'UpdateOnboardingRequest' });
