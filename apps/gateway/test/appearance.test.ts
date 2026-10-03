import { describe, expect, it } from 'vitest';
import {
  colourIssues,
  colourProblem,
  onPrimary,
  PANEL_SURFACE,
  parseAppearance,
} from '../src/widget/appearance.js';
import { DEFAULT_SURFACE, offlineText, widgetConfig } from '../src/widget/copy.js';
import {
  frameAncestors,
  isStudioOrigin,
  LOCAL_ANCESTORS,
  originAllowed,
} from '../src/widget/origins.js';

/** The look of the chat and where it may run (W03, A01): pure rules, without a database. */

const STUDIO = 'https://studio.noor.example';

describe('the main colour', () => {
  it('puts white on dark colours and ink on light ones', () => {
    expect(onPrimary('#192A30')).toBe('#FFFFFF');
    expect(onPrimary('#0B5D3B')).toBe('#FFFFFF');
    expect(onPrimary('#D17B00')).toBe('#192A30');
  });

  it('accepts colours the repo’s contrast check accepts, against the white panel', () => {
    expect(PANEL_SURFACE).toBe('#FFFFFF');
    for (const colour of ['#192A30', '#0B5D3B', '#C2411F', '#1A8754', '#D17B00']) {
      expect(colourIssues(colour), colour).toEqual([]);
    }
  });

  it('refuses text that cannot be read and an accent that disappears on a white page', () => {
    // The brand's own raw coral: white text on it is 3.8:1, ink text 3.9:1.
    const raw = colourIssues('#E45136');
    expect(raw.map((issue) => issue.field)).toEqual(['onAccent']);
    expect(colourProblem(raw[0] as (typeof raw)[number])).toMatch(
      /^Text on this colour is hard to read\..*contrast 3\.\d\d:1; at least 4\.5:1/,
    );
    const pale = colourIssues('#F2F2F2');
    expect(pale.map((issue) => issue.field)).toEqual(['accent']);
    expect(colourProblem(pale[0] as (typeof pale)[number])).toMatch(
      /^This colour is too close to white.*at least 3:1/,
    );
  });
});

describe('the stored appearance', () => {
  it('starts from Hamnivo’s own look and words', () => {
    expect(parseAppearance(undefined)).toEqual({
      primaryColor: '#192A30',
      logoUrl: null,
      radius: 12,
      greeting: null,
      offlineText: null,
      csat: false,
      privacyUrl: null,
    });
  });

  it('falls back to the defaults when what is stored no longer reads', () => {
    expect(parseAppearance({ primaryColor: 'red', radius: 99 }).primaryColor).toBe('#192A30');
    expect(parseAppearance('nonsense').radius).toBe(12);
  });

  it('keeps what was saved', () => {
    const saved = parseAppearance({
      primaryColor: '#0B5D3B',
      radius: 0,
      csat: true,
      greeting: { en: 'Hello', ar: 'مرحبا' },
    });
    expect(saved).toMatchObject({
      primaryColor: '#0B5D3B',
      radius: 0,
      csat: true,
      greeting: { en: 'Hello', ar: 'مرحبا' },
    });
  });
});

describe('the words shown when nobody is online', () => {
  const hours = {
    timezone: 'UTC',
    weekly: {
      sun: [],
      mon: [{ open: '09:00', close: '17:00' }],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    },
    closedDates: [],
  };
  // Saturday 3 October 2026: the team is back on Monday at 09:00 UTC.
  const saturday = new Date('2026-10-03T12:00:00Z');

  it('is nothing when the brand wrote none', () => {
    expect(offlineText(null, 'en', hours, saturday)).toBeNull();
    expect(offlineText(undefined, 'en', hours, saturday)).toBeNull();
  });

  it('fills {when} with the day and time people are back, in the customer’s language', () => {
    expect(offlineText({ en: 'Back {when}.' }, 'en', hours, saturday)).toBe(
      'Back Monday, 9:00 AM UTC.',
    );
    expect(offlineText({ en: 'Back {when}.', ar: 'نعود {when}.' }, 'ar', hours, saturday)).toMatch(
      /^نعود .*الاثنين.*\.$/,
    );
  });

  it('shows English where the customer’s language was left empty', () => {
    expect(offlineText({ en: 'We are away.' }, 'ur', hours, saturday)).toBe('We are away.');
  });

  it('never prints a gap: with no time known, the built-in sentence stands in', () => {
    const never = { ...hours, weekly: { ...hours.weekly, mon: [] } };
    expect(offlineText({ en: 'Back {when}.' }, 'en', never, saturday)).toBe(
      'Our team is away right now. Your messages are kept here, and a person will read them.',
    );
    expect(offlineText({ en: 'Back {when}.' }, 'en', null, saturday)).toBe(
      'Our team is away right now. Your messages are kept here, and a person will read them.',
    );
    expect(offlineText({ en: 'Leave a message.' }, 'en', never, saturday)).toBe('Leave a message.');
  });
});

describe('what the chat is told about its brand', () => {
  const brand = {
    id: 'b',
    name: 'Noor Books',
    widgetPublicId: 'wid_1',
    configVersion: 3,
    businessHours: null,
    theme: {},
  } as never;

  it('uses the defaults for a brand with no appearance', () => {
    const config = widgetConfig(brand, new Date('2026-10-03T12:00:00Z'));
    expect(config.brand).toMatchObject({ accent: '#192A30', onAccent: '#FFFFFF', radius: 12 });
    expect(config.copy.en.greeting).toMatch(/How can we help today/);
    expect(config.features.csat).toBe(false);
    expect(config.privacyPolicyUrl).toBeNull();
  });

  it('uses the brand’s own colours, words, rating and privacy link', () => {
    const config = widgetConfig(brand, new Date('2026-10-03T12:00:00Z'), {
      ...DEFAULT_SURFACE,
      appearance: parseAppearance({
        primaryColor: '#d17b00',
        radius: 2,
        logoUrl: 'https://cdn.noor.example/logo.png',
        greeting: { en: 'Welcome!', hi: 'स्वागत है!' },
        csat: true,
        privacyUrl: 'https://noor.example/privacy',
      }),
    });
    expect(config.brand).toMatchObject({
      accent: '#D17B00',
      onAccent: '#192A30',
      radius: 2,
      logoUrl: 'https://cdn.noor.example/logo.png',
    });
    expect(config.copy.en.greeting).toBe('Welcome!');
    expect(config.copy.hi.greeting).toBe('स्वागत है!');
    // A language the brand left empty shows its English, not Hamnivo's built-in words.
    expect(config.copy.ar.greeting).toBe('Welcome!');
    expect(config.features.csat).toBe(true);
    expect(config.privacyPolicyUrl).toBe('https://noor.example/privacy');
  });
});

describe('Studio’s own page and the test chat', () => {
  it('knows Studio’s page by its origin, however the address is written', () => {
    expect(isStudioOrigin(STUDIO, STUDIO)).toBe(true);
    expect(isStudioOrigin(STUDIO, `${STUDIO}/`)).toBe(true);
    expect(isStudioOrigin(`${STUDIO}/app`, STUDIO)).toBe(true);
    expect(isStudioOrigin(STUDIO, 'https://studio.noor.example.evil.test')).toBe(false);
    expect(isStudioOrigin(STUDIO, 'http://studio.noor.example')).toBe(false);
    expect(isStudioOrigin(STUDIO, undefined)).toBe(false);
    expect(isStudioOrigin(STUDIO, 'not a url')).toBe(false);
  });

  it('lets Studio’s page use the widget only when told it is a test', () => {
    const allowed = ['https://noor.example'];
    expect(originAllowed(allowed, STUDIO)).toBe(false);
    expect(originAllowed(allowed, STUDIO, STUDIO)).toBe(true);
    expect(originAllowed(allowed, 'https://noor.example', STUDIO)).toBe(true);
    // A test does not open the widget to any other website.
    expect(originAllowed(allowed, 'https://other.example', STUDIO)).toBe(false);
    // With no websites yet, local pages still work and Studio's page needs the test too.
    expect(originAllowed([], STUDIO)).toBe(false);
    expect(originAllowed([], STUDIO, STUDIO)).toBe(true);
    expect(originAllowed([], 'http://localhost:3000')).toBe(true);
  });

  it('adds Studio to the pages that may frame the widget for a test, and nothing else', () => {
    const allowed = ['https://noor.example'];
    expect(frameAncestors(allowed, null)).toEqual(allowed);
    expect(frameAncestors(allowed, { studioOrigin: STUDIO })).toEqual([...allowed, STUDIO]);
    expect(frameAncestors([], null)).toEqual(LOCAL_ANCESTORS);
    expect(frameAncestors([], { studioOrigin: STUDIO })).toEqual([...LOCAL_ANCESTORS, STUDIO]);
    // The same origin is not listed twice, and the allowed list is never changed.
    expect(frameAncestors([STUDIO], { studioOrigin: `${STUDIO}/` })).toEqual([STUDIO]);
    expect(allowed).toEqual(['https://noor.example']);
  });
});
