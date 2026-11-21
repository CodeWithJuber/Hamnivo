import type { ReplyLanguage } from '@hamnivo/contracts';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ACTION_EN } from './actions/copy.js';
import { APPEARANCE_EN } from './appearance-copy.js';
import { SHOP_EN } from './commerce/copy.js';
import { EXPERIENCE_EN } from './experience-copy.js';
import { SURFACE_EN } from './surface-copy.js';

/** The chat's words in English: the fallback, always in the first download. */
const en = {
  translation: {
    title: 'Chat',
    placeholder: 'Write a message…',
    send: 'Send',
    talkToPerson: 'Talk to a person',
    backToAssistant: 'Back to the assistant',
    close: 'Close chat',
    you: 'You',
    waitingForPerson: 'Your request is with the support team.',
    withPerson: 'You are chatting with a person from the team.',
    withNamedPerson: 'You are chatting with {{name}} from the team.',
    resolved: 'This conversation is closed. Write to reopen it.',
    reconnecting: 'Reconnecting…',
    offline: 'You are offline. Messages will be sent when you reconnect.',
    sending: 'Sending…',
    notSent: 'Not sent.',
    retry: 'Retry',
    language: 'Language',
    startError: 'The chat could not start. Please try again.',
    chatOffline: 'This chat is offline right now. Please try again later.',
    typing: 'The assistant is writing…',
    personTyping: '{{name}} is typing…',
    aPersonTyping: 'A person from the team is typing…',
    draftChecking: 'Checking this answer…',
    sources: 'Sources',
    languageQuestion: 'Which language should replies use?',
    languageNotNow: 'Not now',
    languageChosen: 'Replies will be in {{language}}.',
    shop: SHOP_EN,
    surface: SURFACE_EN,
    actions: ACTION_EN,
    appearance: APPEARANCE_EN,
    ui: EXPERIENCE_EN,
    memory: {
      open: 'Memory',
      title: 'What we remember',
      intro:
        'Things you told us to remember, to help you in later chats. Only you and the support team can see them.',
      back: 'Back to chat',
      loading: 'Loading…',
      unavailable: 'Memory isn’t available right now. Your chat still works.',
      notOffered: 'This assistant doesn’t remember anything between chats.',
      empty: 'Nothing is remembered yet.',
      never: 'We never remember health, religion, passwords or payment details.',
      reviewTitle: 'Please check',
      error: 'That didn’t work. Please try again.',
      used: 'Based on what you told us before: {{labels}}.',
      see: 'See what we remember',
      consent: {
        title: 'Remember your preferences?',
        what: 'With your OK, the assistant remembers what you ask it to, like your language or how to reach you, to help in later chats.',
        never: 'It never remembers health, religion, passwords or payment details.',
        control:
          'You can see, correct or delete it at any time. Nothing is kept longer than {{days}} days.',
        privacy: 'Privacy policy',
        yes: 'Yes, remember',
        no: 'No, thanks',
        later: 'Decide later',
        declined: 'Nothing will be remembered.',
      },
      switch: {
        label: 'Remember my preferences',
        onHint: 'On. The assistant can use what you told us before.',
        offHint: 'Off. Nothing new is remembered, and nothing is used in replies.',
        turnedOn: 'Memory is on.',
        turnedOff: 'Memory is off.',
      },
      item: {
        source: {
          message: 'From your message on {{date}}',
          staff: 'Updated by the team on {{date}}',
          you: 'Set by you on {{date}}',
        },
        keptUntil: 'Kept until {{date}}',
        notChecked: 'Not checked. It’s what you told us.',
        review: 'Is this right?',
        reviewWithCurrent: 'Is this right? Before, we had: {{current}}.',
        confirm: 'Yes, use this',
        confirmed: 'Saved.',
        keepOld: 'No, keep the old one',
        keptOld: 'Kept the old one.',
        correct: 'Correct',
        correctLabel: 'Correct {{label}}',
        newValue: 'New value for {{label}}',
        valueRequired: 'Enter the new value.',
        save: 'Save',
        saved: 'Saved. The old value is no longer used.',
        cancel: 'Cancel',
        delete: 'Delete',
        deleteLabel: 'Delete {{label}}',
        deleteConfirm: 'Delete this? It won’t be used again.',
        deleteYes: 'Yes, delete',
      },
      receipt: {
        deleted: 'Deleted. It’s no longer used.',
        forgot: 'Everything we remembered about you is deleted.',
        pending: 'We’re removing it from our systems…',
        done: 'Removed everywhere.',
      },
      forget: {
        button: 'Forget everything',
        confirm: 'Delete everything we remember about you? This can’t be undone.',
        yes: 'Yes, forget everything',
      },
      slots: {
        preferred_language: 'Preferred language',
        preferred_name: 'Preferred name',
        contact_method: 'How to contact you',
        contact_time: 'Best time to reach you',
        communication_style: 'Reply style',
        delivery_note: 'Delivery note',
        product_interest: 'Products you asked about',
        size_preference: 'Size',
        open_issue: 'Open request',
        stated_order_reference: 'Order you mentioned',
      },
    },
  },
} as const;

export type Locale = 'en' | 'ar' | 'hi' | 'ur';
export const LOCALES: Locale[] = ['en', 'ar', 'hi', 'ur'];

/** Every string of a language, shaped like English (plural forms may differ by language). */
type Words<T> = { readonly [K in keyof T]: T[K] extends string ? string : Words<T[K]> };
export type Resource = { translation: Words<typeof en.translation> };

/**
 * The other languages load when first needed, each in its own file, so a visitor downloads only
 * the language they read; English, the fallback, is always there.
 */
const OTHERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: object }>> = {
  ar: () => import('./locales/ar.js'),
  hi: () => import('./locales/hi.js'),
  ur: () => import('./locales/ur.js'),
};

/** A language's words. Their keys and placeholders match English (test/i18n.test.ts). */
export async function loadResource(locale: Locale): Promise<Resource> {
  if (locale === 'en') return en;
  const words = (await OTHERS[locale]()).default as Resource['translation'];
  return { translation: words };
}

/** Makes a language ready to show: loads its words the first time it is chosen. */
export async function ensureLocale(locale: Locale): Promise<void> {
  if (i18next.hasResourceBundle(locale, 'translation')) return;
  const { translation } = await loadResource(locale);
  i18next.addResourceBundle(locale, 'translation', translation);
}
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
  const resources: Partial<Record<Locale, Resource>> = { en };
  if (locale !== 'en') resources[locale] = await loadResource(locale);
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
