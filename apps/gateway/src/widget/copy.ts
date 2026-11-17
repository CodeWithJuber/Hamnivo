import {
  type ChatFormField,
  ConsentSettings,
  DEFAULT_WIDGET_TEXT,
  type HandoffResponse,
  type LauncherConfig,
  type LocalizedText,
  PromptLimits,
  WidgetAppearance,
  type WidgetConfig,
  type WidgetFormField,
  WidgetForms,
  WidgetSettings,
} from '@hamnivo/contracts';
import type { schema } from '@hamnivo/db';
import { isOpen, nextOpening } from '@hamnivo/domain';
import { splitForBrowser } from '@hamnivo/domain/automations';
import { onPrimary } from './appearance.js';
import type { BrandSurface } from './settings.service.js';

type Locale = 'en' | 'ar' | 'hi' | 'ur';

/** Default widget copy (design kit §5 microcopy). Tenants override it; translations await native review. */
const COPY: Record<Locale, WidgetConfig['copy'][Locale]> = {
  en: {
    greeting: DEFAULT_WIDGET_TEXT.greeting.en,
    aiDisclosure: "I'm {brand}'s AI assistant. I can help here, or connect you with a person.",
    offlineMessage:
      'Your request is with the support team. You can keep this chat open or leave a reply address.',
    privacyNotice: null,
  },
  ar: {
    greeting: DEFAULT_WIDGET_TEXT.greeting.ar,
    aiDisclosure: 'أنا المساعد الذكي لدى {brand}. يمكنني المساعدة هنا، أو إيصالك بشخص من الفريق.',
    offlineMessage: 'طلبك لدى فريق الدعم. يمكنك إبقاء هذه المحادثة مفتوحة أو ترك عنوان للرد.',
    privacyNotice: null,
  },
  hi: {
    greeting: DEFAULT_WIDGET_TEXT.greeting.hi,
    aiDisclosure: 'मैं {brand} का एआई सहायक हूँ। मैं यहाँ मदद कर सकता हूँ, या आपको किसी व्यक्ति से जोड़ सकता हूँ।',
    offlineMessage:
      'आपका अनुरोध सपोर्ट टीम के पास है। आप यह चैट खुली रख सकते हैं या जवाब के लिए पता छोड़ सकते हैं।',
    privacyNotice: null,
  },
  ur: {
    greeting: DEFAULT_WIDGET_TEXT.greeting.ur,
    aiDisclosure:
      'میں {brand} کا اے آئی اسسٹنٹ ہوں۔ میں یہاں مدد کر سکتا ہوں، یا آپ کو کسی شخص سے ملا سکتا ہوں۔',
    offlineMessage:
      'آپ کی درخواست سپورٹ ٹیم کے پاس ہے۔ آپ یہ چیٹ کھلی رکھ سکتے ہیں یا جواب کے لیے پتہ چھوڑ سکتے ہیں۔',
    privacyNotice: null,
  },
};

/** "People are away" with the time they are back, or without it when that is not known. */
const AWAY = (lang: Locale, when: string): string =>
  DEFAULT_WIDGET_TEXT.away[lang].replace('{when}', when);
const AWAY_UNKNOWN = DEFAULT_WIDGET_TEXT.awayUnknown;

/** "A person is here": said only when someone who can answer is online now; translations await native review. */
const PERSON_ONLINE: Record<Locale, string> = {
  en: 'A person from our team is online and will join this chat shortly.',
  ar: 'أحد أفراد فريقنا متصل الآن وسينضم إلى هذه المحادثة قريبًا.',
  hi: 'हमारी टीम का एक व्यक्ति ऑनलाइन है और जल्द ही इस चैट में जुड़ेगा।',
  ur: 'ہماری ٹیم کا ایک فرد آن لائن ہے اور جلد اس چیٹ میں شامل ہوگا۔',
};

/** What the customer is told after withdrawing a request for a person (HNV-10-02, HNV-10-05). */
const RETURN_TO_ASSISTANT: Record<
  Locale,
  Record<'with_assistant' | 'person_joined' | 'with_people', string>
> = {
  en: {
    with_assistant:
      'You’re chatting with the assistant again. You can ask for a person at any time.',
    person_joined: 'A person from our team has already joined this chat.',
    with_people: 'This chat stays with our team. A person will answer you here.',
  },
  ar: {
    with_assistant: 'أنت تتحدث مع المساعد مرة أخرى. يمكنك طلب شخص في أي وقت.',
    person_joined: 'انضم أحد أفراد فريقنا إلى هذه المحادثة بالفعل.',
    with_people: 'تبقى هذه المحادثة مع فريقنا. سيرد عليك شخص هنا.',
  },
  hi: {
    with_assistant: 'आप फिर से सहायक से बात कर रहे हैं। आप कभी भी किसी व्यक्ति से बात करने को कह सकते हैं।',
    person_joined: 'हमारी टीम का एक व्यक्ति इस चैट में पहले ही जुड़ चुका है।',
    with_people: 'यह चैट हमारी टीम के पास रहेगी। कोई व्यक्ति आपको यहीं जवाब देगा।',
  },
  ur: {
    with_assistant:
      'آپ دوبارہ معاون سے بات کر رہے ہیں۔ آپ کسی بھی وقت کسی فرد سے بات کرنے کو کہہ سکتے ہیں۔',
    person_joined: 'ہماری ٹیم کا ایک فرد اس چیٹ میں پہلے ہی شامل ہو چکا ہے۔',
    with_people: 'یہ چیٹ ہماری ٹیم کے پاس رہے گی۔ کوئی فرد آپ کو یہیں جواب دے گا۔',
  },
};

export function returnToAssistantMessage(
  outcome: 'with_assistant' | 'person_joined' | 'with_people',
  locale: string | null | undefined,
): string {
  return RETURN_TO_ASSISTANT[localeOf(locale)][outcome];
}

const localeOf = (locale: string | null | undefined): Locale =>
  (['en', 'ar', 'hi', 'ur'] as const).find((l) => l === locale) ?? 'en';

/**
 * Whether people are working now and when they are back, from the brand's hours (W11), and
 * whether anyone on the team is online right now (their own status).
 */
export function availabilityOf(
  brand: typeof schema.brands.$inferSelect,
  now: Date,
  staffOnline = false,
): WidgetConfig['availability'] {
  const hours = brand.businessHours;
  // Without hours there is no way to know: never claim a person is standing by.
  if (!hours) {
    return {
      humanAvailable: false,
      nextOpenAt: null,
      timezone: 'UTC',
      staffOnline,
      hoursSet: false,
      open: false,
    };
  }
  const open = isOpen(hours, now);
  return {
    humanAvailable: open,
    nextOpenAt: open ? null : (nextOpening(hours, now)?.toISOString() ?? null),
    timezone: hours.timezone,
    staffOnline,
    hoursSet: true,
    open,
  };
}

const DEFAULT_APPEARANCE = WidgetAppearance.parse({});

/** Defaults for a brand that has saved no settings. */
export const DEFAULT_SURFACE: BrandSurface = {
  settings: WidgetSettings.parse({}),
  promptLimits: PromptLimits.parse({}),
  prompts: [],
  appearance: DEFAULT_APPEARANCE,
  forms: WidgetForms.parse({}),
  consent: ConsentSettings.parse({}),
  consentVersion: 0,
  directLink: false,
  settingsUpdatedAt: null,
  promptLimitsUpdatedAt: null,
  formsUpdatedAt: null,
  consentUpdatedAt: null,
  directLinkUpdatedAt: null,
};

/** What the session adds to the brand's configuration: who is asking, and from where. */
export interface ConfigContext {
  /** Files are offered only where they can be scanned (ClamAV in production). */
  filesScannable?: boolean;
  /** Someone on the team is online right now. */
  staffOnline?: boolean;
  /** This visitor must agree before chatting (from the brand's mode and the request's country). */
  consentRequired?: boolean;
  /** This customer agreed to the current words already. */
  consentGiven?: boolean;
  /** The session was opened from the brand's direct chat link (W28). */
  direct?: boolean;
  /** False when this customer is blocked (H20); the widget says only that chat is unavailable. */
  chatAvailable?: boolean;
  /** Who is online (first name and photo only) and how soon people usually reply (W17). */
  team?: WidgetConfig['team'];
}

const LOCALES: Locale[] = ['en', 'ar', 'hi', 'ur'];

/** A brand's text in one language, falling back to its English. */
const textIn = (text: LocalizedText, locale: Locale): string => text[locale] ?? text.en;

/** The text in every language. */
const everyLocale = (text: LocalizedText): Record<Locale, string> =>
  Object.fromEntries(LOCALES.map((locale) => [locale, textIn(text, locale)])) as Record<
    Locale,
    string
  >;

/** A form field as the widget shows it. */
const formField = (field: ChatFormField): WidgetFormField => ({
  id: field.id,
  kind: field.kind,
  label: everyLocale(field.label),
  required: field.required,
  options: field.options.map((option) => ({ id: option.id, label: everyLocale(option.label) })),
});

/** The brand's consent words, or Hamnivo's own, with its name in them. */
export function consentText(brandName: string, text: LocalizedText | null): Record<Locale, string> {
  return Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      text
        ? textIn(text, locale)
        : DEFAULT_WIDGET_TEXT.consent[locale].replace('{brand}', brandName),
    ]),
  ) as Record<Locale, string>;
}

/** "Monday 9:00 AM GMT+5": when people are back, in the customer's language and the brand's time zone. */
function whenText(lang: Locale, timezone: string, back: Date): string {
  return new Intl.DateTimeFormat(lang, {
    weekday: 'long',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(back);
}

/**
 * The brand's own words for "nobody is online", in the customer's language, or null when it has
 * none. Where the text says `{when}` it becomes the time people are back; when that is not known,
 * the built-in sentence for an unknown return is shown instead of a gap.
 */
export function offlineText(
  text: LocalizedText | null | undefined,
  lang: Locale,
  hours: typeof schema.brands.$inferSelect.businessHours,
  now: Date,
): string | null {
  if (!text) return null;
  const own = textIn(text, lang);
  if (!own.includes('{when}')) return own;
  const back = hours ? nextOpening(hours, now) : null;
  return back && hours
    ? own.replaceAll('{when}', whenText(lang, hours.timezone, back))
    : AWAY_UNKNOWN[lang];
}

export function widgetConfig(
  brand: typeof schema.brands.$inferSelect,
  now: Date = new Date(),
  surface: BrandSurface = DEFAULT_SURFACE,
  options: ConfigContext = {},
): WidgetConfig {
  const { settings } = surface;
  const appearance = surface.appearance ?? DEFAULT_APPEARANCE;
  const copy = Object.fromEntries(
    (Object.keys(COPY) as Locale[]).map((locale) => [
      locale,
      {
        ...COPY[locale],
        aiDisclosure: COPY[locale].aiDisclosure.replace('{brand}', brand.name),
        // The brand's own words replace the built-in ones; a language it left empty shows its English.
        launcherLabel: appearance.launcherLabel
          ? textIn(appearance.launcherLabel, locale)
          : undefined,
        greeting: appearance.greeting ? textIn(appearance.greeting, locale) : COPY[locale].greeting,
        offlineMessage:
          offlineText(appearance.offlineText, locale, brand.businessHours, now) ??
          COPY[locale].offlineMessage,
      },
    ]),
  ) as WidgetConfig['copy'];
  const availability = availabilityOf(brand, now, options.staffOnline === true);
  const { prechat, offline } = surface.forms;
  return {
    widgetId: brand.widgetPublicId,
    version: brand.configVersion,
    brand: {
      name: brand.name,
      logoUrl: appearance.logoUrl,
      accent: appearance.primaryColor.toUpperCase(),
      onAccent: onPrimary(appearance.primaryColor),
      radius: appearance.radius,
      fontFamily: appearance.fontFamily,
      showBranding: appearance.showBranding,
      launcherPosition: settings.layout.position,
      // Left out until the brand chose, so a chat from before them reads the same config.
      ...(appearance.theme ? { theme: appearance.theme } : {}),
      ...(appearance.headerStyle ? { headerStyle: appearance.headerStyle } : {}),
    },
    locales: { default: 'en', available: ['en', 'ar', 'hi', 'ur'] },
    copy,
    ...(options.team ? { team: options.team } : {}),
    availability,
    features: {
      attachments: settings.attachments.enabled && options.filesScannable !== false,
      helpCenter: settings.help.search,
      csat: appearance.csat,
      voice: false,
      identityRequiredForHistory: false,
    },
    privacyPolicyUrl: appearance.privacyUrl,
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
      triggers: (surface.prompts ?? []).flatMap((rule) =>
        rule.definition.actions.flatMap((action) =>
          action.type === 'show_prompt'
            ? [{ id: rule.publicId, message: everyLocale(action.message) }]
            : [],
        ),
      ),
    },
    forms: {
      prechat: {
        enabled: prechat.enabled,
        skipVerified: prechat.skipVerified,
        fields: prechat.fields.map(formField),
      },
      offline: {
        enabled: offline.enabled,
        when: offline.when,
        fields: offline.fields.map(formField),
        thanks: offline.thanks
          ? everyLocale(offline.thanks)
          : { ...DEFAULT_WIDGET_TEXT.offlineThanks },
      },
    },
    consent: {
      required: options.consentRequired === true,
      given: options.consentGiven === true,
      noticeVersion: surface.consentVersion,
      text: consentText(brand.name, surface.consent.text),
    },
    direct: options.direct === true,
    chatAvailable: options.chatAvailable !== false,
  };
}

/** The loader's own words (W01, W02, W19): its button, the chat frame and a prompt's close. */
const LAUNCHER_COPY: Record<
  Locale,
  Omit<LauncherConfig['launcher'], 'accent' | 'onAccent' | 'label' | 'fontFamily'>
> = {
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

/** What the gateway knows about a visitor when the loader asks (never stored). */
export interface LauncherContext {
  /** From the edge's country header, for this request only. */
  country?: string | null;
  /** Someone on the team is online right now (asked only when a rule needs it). */
  staffOnline?: boolean;
}

/**
 * What the loader needs before the widget loads (W02, G21): the layout, launcher colours and
 * labels, and the website prompts in one language. Each published website automation is checked
 * here against what the gateway knows (country, language, hours, who is online); what is left
 * goes to the loader, which checks the page, referrer, visits and device and keeps to the brand's
 * daily limit.
 */
export function launcherConfig(
  brand: typeof schema.brands.$inferSelect,
  surface: BrandSurface,
  locale: string | null | undefined,
  now: Date,
  context: LauncherContext = {},
): LauncherConfig {
  const lang = localeOf(locale);
  const config = widgetConfig(brand, now, surface);
  const facts = {
    country: context.country ?? null,
    language: locale ?? null,
    hours_open: brand.businessHours ? config.availability.open : null,
    anyone_online: context.staffOnline ?? null,
  };
  const rules = surface.prompts.flatMap((rule) => {
    const prompt = rule.definition.actions.find((action) => action.type === 'show_prompt');
    const split = prompt ? splitForBrowser(rule.definition, facts) : null;
    if (prompt?.type !== 'show_prompt' || !split) return [];
    return [
      {
        id: rule.publicId,
        seconds: rule.definition.event.seconds,
        any: split.any,
        when: split.when,
        message: textIn(prompt.message, lang),
      },
    ];
  });
  return {
    widgetId: brand.widgetPublicId,
    version: brand.configVersion,
    locale: lang,
    dir: lang === 'ar' || lang === 'ur' ? 'rtl' : 'ltr',
    layout: {
      ...config.layout,
      ...(surface.settings.layout.offset ? { offset: surface.settings.layout.offset } : {}),
      ...(surface.settings.layout.hideOnMobile ? { hideOnMobile: true } : {}),
    },
    ...(config.brand.theme ? { theme: config.brand.theme } : {}),
    launcher: {
      ...(surface.appearance?.launcherIcon ? { icon: surface.appearance.launcherIcon } : {}),
      ...(surface.appearance?.launcherSize ? { size: surface.appearance.launcherSize } : {}),
      accent: config.brand.accent,
      onAccent: config.brand.onAccent,
      ...LAUNCHER_COPY[lang],
      fontFamily: config.brand.fontFamily,
      label: config.copy[lang]?.launcherLabel ?? null,
      openLabel: config.copy[lang]?.launcherLabel ?? LAUNCHER_COPY[lang].openLabel,
    },
    proactive: {
      enabled: rules.length > 0,
      maxPerDay: surface.promptLimits.maxPerDay,
      dismissHours: surface.promptLimits.dismissHours,
      triggers: [],
      rules,
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
  /** The brand's own words for "nobody is online" (its appearance), when it has set some. */
  offline?: LocalizedText | null,
  /** Someone who can answer is online right now (staff availability); false when unknown. */
  staffOnline = false,
): Pick<HandoffResponse, 'availability' | 'message' | 'followUp'> {
  const lang = localeOf(locale);
  const hours = brand?.businessHours;
  if (!hours || isOpen(hours, now)) {
    return staffOnline
      ? { availability: 'person_available', message: PERSON_ONLINE[lang], followUp: null }
      : { availability: 'queued', message: COPY[lang].offlineMessage, followUp: null };
  }
  const back = nextOpening(hours, now);
  const own = offlineText(offline, lang, hours, now);
  if (!back) {
    return { availability: 'offline', message: own ?? AWAY_UNKNOWN[lang], followUp: null };
  }
  return {
    availability: 'offline',
    message: own ?? AWAY(lang, whenText(lang, hours.timezone, back)),
    followUp: { channel: 'this_chat', expectedBy: back.toISOString() },
  };
}
