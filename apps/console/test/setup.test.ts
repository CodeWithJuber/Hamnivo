import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MODEL_CATALOG as CONTRACT_CATALOG,
  DEFAULT_PRIMARY_COLOR as CONTRACT_COLOUR,
  CUSTOM_MODEL as CONTRACT_CUSTOM,
  DEFAULT_RADIUS as CONTRACT_RADIUS,
  ONBOARDING_STEPS as CONTRACT_STEPS,
  DEFAULT_WIDGET_TEXT as CONTRACT_TEXT,
  modelDropdownValue as contractDropdown,
  recommendedModel as contractRecommended,
  MODEL_PROBE_MESSAGES,
} from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { setupEn } from '../src/i18n/setup/en';
import {
  type AppearanceDraft,
  bodyOf,
  draftOf,
  drawnColour,
  isDirty,
  isHttpsUrl,
  localizedOf,
  problemsOf,
  textsOf,
} from '../src/lib/appearance';
import {
  ALL_DAY,
  bodyOfHours,
  dayName,
  daysText,
  draftOfHours,
  emptyHours,
  groupDays,
  isTimeZone,
  MAX_SPANS,
  problemsOfHours,
  spansText,
  WEEK,
  WEEKDAYS,
  WORKING_SPAN,
  weekOf,
} from '../src/lib/hours';
import { isKeyName, parseJwk } from '../src/lib/identity';
import { guideSlug, isPlatform, PLATFORMS } from '../src/lib/install';
import {
  currentStep,
  firstOpen,
  isStep,
  nextStep,
  previousStep,
  stateOf,
  tally,
} from '../src/lib/onboarding';
import {
  checkColour,
  hasServerKey,
  isHexColour,
  issuesOf,
  onColour,
  testChatUrl,
} from '../src/lib/setup';
import {
  CUSTOM_MODEL,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_RADIUS,
  DEFAULT_WIDGET_TEXT,
  MODEL_CATALOG,
  modelDropdownValue,
  ONBOARDING_STEPS,
  recommendedModel,
} from '../src/lib/setup-data';
import { websiteOf } from '../src/pages/onboarding/BrandStep';
import { addable } from '../src/pages/settings/TeamsPage';

// Studio imports only the types of @hamnivo/contracts, so the schema library stays out of the
// page. The lists it needs at run time are kept as data in lib/setup-data.ts; these tests fail
// when a copy drifts from the one the gateway checks.
describe('Studio’s copy of the setup lists', () => {
  it('has the models the gateway lists, with the same recommended one', () => {
    expect(MODEL_CATALOG).toEqual(CONTRACT_CATALOG);
    expect(CUSTOM_MODEL).toBe(CONTRACT_CUSTOM);
    for (const provider of Object.keys(CONTRACT_CATALOG) as (keyof typeof CONTRACT_CATALOG)[]) {
      expect(recommendedModel(provider)).toBe(contractRecommended(provider));
      for (const model of CONTRACT_CATALOG[provider]) {
        expect(modelDropdownValue(provider, model.id)).toBe(contractDropdown(provider, model.id));
      }
      expect(modelDropdownValue(provider, 'something-else')).toBe(
        contractDropdown(provider, 'something-else'),
      );
    }
  });

  it('has the words the chat starts with, and its look', () => {
    expect(DEFAULT_WIDGET_TEXT).toEqual(CONTRACT_TEXT);
    expect(DEFAULT_PRIMARY_COLOR).toBe(CONTRACT_COLOUR);
    expect(DEFAULT_RADIUS).toBe(CONTRACT_RADIUS);
  });

  it('has the steps of the guided setup, in order', () => {
    expect([...ONBOARDING_STEPS]).toEqual([...CONTRACT_STEPS]);
  });

  it('words every way a key test can end', () => {
    const kinds = Object.keys(MODEL_PROBE_MESSAGES).sort();
    expect(Object.keys(setupEn.models.probe).sort()).toEqual(kinds);
    for (const kind of kinds) {
      const words = setupEn.models.probe[kind as keyof typeof setupEn.models.probe];
      expect(words.title.length, kind).toBeGreaterThan(0);
      expect(words.body.length, kind).toBeGreaterThan(0);
    }
  });

  it('starts every provider with a model, except a server of your own', () => {
    expect(recommendedModel('openai')).toBe('gpt-5.4-mini');
    expect(recommendedModel('anthropic')).toBe('claude-haiku-4-5');
    expect(recommendedModel('openai-compatible')).toBeNull();
    // A model that is not on the list is typed in, and a listed one is picked.
    expect(modelDropdownValue('openai', 'gpt-5.4')).toBe('gpt-5.4');
    expect(modelDropdownValue('openai', 'my-fine-tune')).toBe('custom');
    expect(modelDropdownValue('openai-compatible', 'llama')).toBe('custom');
  });
});

describe('which AI keys the server holds', () => {
  it('is known only once the status has loaded, and yes when any provider has one', () => {
    expect(hasServerKey(undefined)).toBeUndefined();
    const status = (openai: boolean) =>
      ({
        serverKeys: { anthropic: false, openai, google: false, openaiCompatible: false },
      }) as Parameters<typeof hasServerKey>[0];
    expect(hasServerKey(status(false))).toBe(false);
    expect(hasServerKey(status(true))).toBe(true);
  });
});

describe('the main colour', () => {
  it('reads a colour code, and nothing else', () => {
    expect(isHexColour('#D17B00')).toBe(true);
    expect(isHexColour(' #d17b00 ')).toBe(true);
    expect(isHexColour('D17B00')).toBe(false);
    expect(isHexColour('#D17B0')).toBe(false);
    expect(isHexColour('orange')).toBe(false);
    expect(checkColour('orange')).toBeNull();
  });

  it('accepts the chat’s own ink and a colour with readable text on it', () => {
    expect(checkColour('#192A30')).toEqual({ on: '#FFFFFF', problem: null, suggestion: null });
    expect(checkColour('#D17B00')?.problem).toBeNull();
    expect(issuesOf('#D17B00')).toEqual([]);
  });

  it('chooses white or ink for the text on it, whichever reads better', () => {
    expect(onColour('#000000')).toBe('#FFFFFF');
    expect(onColour('#FFD400')).toBe('#192A30');
  });

  it('says when text on a colour is hard to read, and suggests one that passes', () => {
    const check = checkColour('#808080');
    expect(check?.problem).toBe('text');
    expect(check?.suggestion).toMatch(/^#[0-9A-F]{6}$/);
    expect(issuesOf(check?.suggestion ?? '#808080')).toEqual([]);
  });

  it('says when a colour is too close to white to show, and suggests a darker one', () => {
    const check = checkColour('#F2F2F2');
    expect(check?.problem).toBe('faint');
    expect(issuesOf(check?.suggestion ?? '#F2F2F2')).toEqual([]);
    // Darker: no channel is brighter than the one it came from.
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(check?.suggestion?.slice(i, i + 2) ?? 'ff', 16),
    );
    expect(Math.max(r ?? 255, g ?? 255, b ?? 255)).toBeLessThan(0xf2);
  });

  it('gives a suggestion for every colour that fails, wherever it starts', () => {
    for (const colour of ['#E0B000', '#E45136', '#FFFFFF', '#CCCCCC', '#777777']) {
      const check = checkColour(colour);
      if (!check?.problem) continue;
      expect(check.suggestion, colour).not.toBeNull();
      expect(issuesOf(check.suggestion ?? colour), colour).toEqual([]);
    }
  });
});

describe('the test chat address', () => {
  const url = new URL(testChatUrl('wid_noor', 'ar', 'https://studio.example'));

  it('opens the widget page, for the brand, as a test', () => {
    expect(url.origin).toBe('http://localhost:5174');
    expect(url.searchParams.get('widgetId')).toBe('wid_noor');
    expect(url.searchParams.get('test')).toBe('1');
    expect(url.searchParams.get('mode')).toBe('inline');
  });

  it('names Studio as the page that frames it, and the gateway it talks to', () => {
    expect(url.searchParams.get('host')).toBe('https://studio.example');
    expect(url.searchParams.get('api')).toBe('http://localhost:4000');
  });

  it('keeps its own session apart from a customer’s, in the person’s language', () => {
    expect(url.searchParams.get('instance')).toBe('studio-test');
    expect(url.searchParams.get('locale')).toBe('ar');
  });
});

// ------------------------------------------------------------------ how the chat looks

const saved = {
  primaryColor: '#d17b00',
  logoUrl: 'https://noor.example/logo.png',
  radius: 8,
  greeting: { en: 'Hello!', ar: 'مرحبا' },
  offlineText: null,
  csat: true,
  privacyUrl: null,
};
const draft = (patch: Partial<AppearanceDraft> = {}): AppearanceDraft => ({
  ...draftOf(saved),
  ...patch,
});

describe('the look editor’s working copy', () => {
  it('holds what is saved, one text per language', () => {
    expect(draftOf(saved)).toEqual({
      colour: '#D17B00',
      logoUrl: 'https://noor.example/logo.png',
      radius: 8,
      greeting: { en: 'Hello!', ar: 'مرحبا', hi: '', ur: '' },
      offline: { en: '', ar: '', hi: '', ur: '' },
      csat: true,
      privacyUrl: '',
    });
  });

  it('saves what was typed, leaving out the languages and addresses that are empty', () => {
    expect(bodyOf(draftOf(saved))).toEqual({
      primaryColor: '#D17B00',
      logoUrl: 'https://noor.example/logo.png',
      radius: 8,
      greeting: { en: 'Hello!', ar: 'مرحبا' },
      offlineText: null,
      csat: true,
      privacyUrl: null,
    });
    expect(bodyOf(draft({ logoUrl: '  ', colour: ' #d17b00 ' }))).toMatchObject({
      logoUrl: null,
      primaryColor: '#D17B00',
    });
  });

  it('knows when something changed, and when it was put back', () => {
    const start = draftOf(saved);
    expect(isDirty(start, draftOf(saved))).toBe(false);
    expect(isDirty(draft({ radius: 9 }), start)).toBe(true);
    expect(isDirty(draft({ radius: 8 }), start)).toBe(false);
  });

  it('writes nothing for texts that are all empty, so Hamnivo’s own words are used', () => {
    expect(localizedOf(textsOf({}))).toBeNull();
    expect(localizedOf(textsOf({ en: '   ' }))).toBeNull();
    expect(localizedOf(textsOf({ en: ' Hi ', ur: 'سلام' }))).toEqual({ en: 'Hi', ur: 'سلام' });
  });

  it('draws with the colour typed when it is one, else the chat’s own', () => {
    expect(drawnColour(draft({ colour: '#abcdef' }), '#192A30')).toBe('#ABCDEF');
    expect(drawnColour(draft({ colour: '#abc' }), '#192A30')).toBe('#192A30');
  });
});

describe('what would be refused before it is sent', () => {
  it('finds nothing wrong with a good look', () => {
    expect(problemsOf(draftOf(saved))).toEqual({});
  });

  it('refuses a colour that is not a colour code, or that cannot be read', () => {
    expect(problemsOf(draft({ colour: 'orange' })).colour).toBe('colourFormat');
    expect(problemsOf(draft({ colour: '#808080' })).colour).toBe('colourText');
    expect(problemsOf(draft({ colour: '#F2F2F2' })).colour).toBe('colourFaint');
  });

  it('takes only https addresses without a user name or password', () => {
    expect(isHttpsUrl('https://noor.example/privacy')).toBe(true);
    expect(isHttpsUrl('http://noor.example')).toBe(false);
    expect(isHttpsUrl('https://user:pass@noor.example')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
    expect(isHttpsUrl(`https://noor.example/${'a'.repeat(500)}`)).toBe(false);
    expect(problemsOf(draft({ logoUrl: 'http://x.example/l.png' })).logoUrl).toBe('url');
    expect(problemsOf(draft({ privacyUrl: 'ftp://x.example' })).privacyUrl).toBe('url');
    expect(problemsOf(draft({ logoUrl: '', privacyUrl: '' }))).toEqual({});
  });

  it('wants the English text first, because the others fall back to it', () => {
    const only = (lang: 'ar' | 'hi' | 'ur') => textsOf({ [lang]: 'نص' });
    expect(problemsOf(draft({ greeting: only('ar') })).greeting).toBe('english');
    expect(problemsOf(draft({ offline: only('ur') })).offline).toBe('english');
    expect(problemsOf(draft({ greeting: textsOf({}) })).greeting).toBeUndefined();
  });
});

// ------------------------------------------------------------------ business hours

describe('business hours as a form holds them', () => {
  const stored = {
    timezone: 'Asia/Karachi',
    weekly: {
      sun: [],
      mon: [{ open: '09:00', close: '17:00' }],
      tue: [{ open: '09:00', close: '17:00' }],
      wed: [
        { open: '09:00', close: '13:00' },
        { open: '14:00', close: '24:00' },
      ],
      thu: [],
      fri: [],
      sat: [],
    },
    closedDates: ['2026-12-25', '2026-08-14'],
  };

  it('shows the end of a day as midnight (00:00), and saves it as 24:00 again', () => {
    const form = draftOfHours(stored, 'UTC');
    expect(form.weekly.wed).toEqual([
      { open: '09:00', close: '13:00' },
      { open: '14:00', close: '00:00' },
    ]);
    expect(bodyOfHours(form)).toEqual({
      ...stored,
      closedDates: ['2026-08-14', '2026-12-25'],
    });
  });

  it('starts empty, in the person’s own time zone, for a brand with no hours', () => {
    expect(draftOfHours(null, 'Asia/Dubai')).toEqual(emptyHours('Asia/Dubai'));
    expect(Object.values(emptyHours('UTC').weekly).every((day) => day.length === 0)).toBe(true);
  });

  it('puts Monday first, the way a week is read', () => {
    expect(WEEK[0]).toBe('mon');
    expect(WEEK[6]).toBe('sun');
    expect(dayName('mon', 'en')).toBe('Monday');
    expect(dayName('fri', 'en', 'short')).toBe('Fri');
    expect(dayName('sun', 'ar')).not.toBe(dayName('sun', 'en'));
  });

  it('fills the week from a quick start', () => {
    const weekdays = weekOf(WEEKDAYS, [WORKING_SPAN]);
    expect(weekdays.mon).toEqual([{ open: '09:00', close: '17:00' }]);
    expect(weekdays.sat).toEqual([]);
    expect(weekOf(WEEK, [ALL_DAY]).sun).toEqual([{ open: '00:00', close: '00:00' }]);
    // Each day has its own spans: changing one day does not change another.
    weekdays.mon[0] = { open: '10:00', close: '11:00' };
    expect(weekdays.tue).toEqual([{ open: '09:00', close: '17:00' }]);
  });
});

describe('what the gateway would refuse in business hours', () => {
  const week = (patch: Partial<ReturnType<typeof emptyHours>['weekly']>) => ({
    ...emptyHours('Asia/Karachi'),
    weekly: { ...emptyHours('Asia/Karachi').weekly, ...patch },
  });

  it('finds nothing wrong with a normal week, or with all day', () => {
    expect(problemsOfHours(week({ mon: [{ open: '09:00', close: '17:00' }] }))).toEqual([]);
    expect(problemsOfHours(week({ sat: [{ open: '00:00', close: '00:00' }] }))).toEqual([]);
    expect(problemsOfHours(emptyHours('UTC'))).toEqual([]);
  });

  it('wants closing after opening', () => {
    expect(problemsOfHours(week({ tue: [{ open: '17:00', close: '09:00' }] }))).toEqual([
      { kind: 'order', day: 'tue', index: 0 },
    ]);
    expect(problemsOfHours(week({ tue: [{ open: '09:00', close: '09:00' }] }))).toEqual([
      { kind: 'order', day: 'tue', index: 0 },
    ]);
  });

  it('wants a time in each box', () => {
    expect(problemsOfHours(week({ mon: [{ open: '', close: '17:00' }] }))).toEqual([
      { kind: 'time', day: 'mon', index: 0 },
    ]);
  });

  it('refuses times on one day that overlap, and allows ones that touch', () => {
    const overlap = week({
      wed: [
        { open: '09:00', close: '13:00' },
        { open: '12:00', close: '15:00' },
      ],
    });
    expect(problemsOfHours(overlap)).toEqual([{ kind: 'overlap', day: 'wed' }]);
    const touching = week({
      wed: [
        { open: '09:00', close: '13:00' },
        { open: '13:00', close: '15:00' },
      ],
    });
    expect(problemsOfHours(touching)).toEqual([]);
    // Listed out of order, they are still compared in time order.
    const reversed = week({
      wed: [
        { open: '14:00', close: '16:00' },
        { open: '09:00', close: '15:00' },
      ],
    });
    expect(problemsOfHours(reversed)).toEqual([{ kind: 'overlap', day: 'wed' }]);
  });

  it('refuses a time zone the browser does not know, and a closed day that is not a date', () => {
    expect(isTimeZone('Asia/Karachi')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
    expect(problemsOfHours({ ...emptyHours('Mars/Olympus') })).toEqual([{ kind: 'zone' }]);
    expect(problemsOfHours({ ...emptyHours('UTC'), closedDates: ['2026-02-30x'] })).toEqual([
      { kind: 'date', value: '2026-02-30x' },
    ]);
  });

  it('allows as many spans in a day as the gateway does', () => {
    expect(MAX_SPANS).toBe(6);
  });
});

describe('business hours in words', () => {
  it('puts days that share hours together, and leaves out the days that are closed', () => {
    const hours = week();
    expect(groupDays(hours)).toEqual([
      { days: ['mon', 'tue', 'wed', 'thu', 'fri'], spans: [{ open: '09:00', close: '17:00' }] },
      { days: ['sat'], spans: [{ open: '10:00', close: '14:00' }] },
    ]);
  });

  it('does not join days that have the same hours but are not next to each other', () => {
    const groups = groupDays({
      ...weekOf([], []),
      mon: [{ open: '09:00', close: '17:00' }],
      wed: [{ open: '09:00', close: '17:00' }],
    });
    expect(groups.map((group) => group.days)).toEqual([['mon'], ['wed']]);
  });

  it('writes a range of days and their times', () => {
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri'], 'en', 'to')).toBe('Mon to Fri');
    expect(daysText(['sat'], 'en', 'to')).toBe('Sat');
    expect(daysText([], 'en', 'to')).toBe('');
    expect(
      spansText(
        [
          { open: '09:00', close: '13:00' },
          { open: '14:00', close: '00:00' },
        ],
        'to',
      ),
    ).toBe('09:00 to 13:00, 14:00 to 24:00');
  });

  function week() {
    return {
      ...weekOf(WEEKDAYS, [WORKING_SPAN]),
      sat: [{ open: '10:00', close: '14:00' }],
      sun: [],
    };
  }
});

// ------------------------------------------------------------------ the guided setup

describe('the guided setup’s place', () => {
  const progress = (steps: Record<string, 'done' | 'skipped'>) =>
    ({ steps }) as Parameters<typeof tally>[0];

  it('starts at the first step, and carries on from the first one not dealt with', () => {
    expect(firstOpen(undefined)).toBe('workspace');
    expect(firstOpen(progress({ workspace: 'done', brand: 'done' }))).toBe('engine');
    expect(firstOpen(progress({ workspace: 'skipped', brand: 'done' }))).toBe('engine');
  });

  it('comes back to a skipped step only when asked, and has none left once all are dealt with', () => {
    const all = Object.fromEntries(ONBOARDING_STEPS.map((step) => [step, 'skipped' as const]));
    expect(firstOpen(progress(all))).toBeNull();
    expect(stateOf(progress(all), 'team')).toBe('skipped');
    expect(stateOf(progress({}), 'team')).toBe('todo');
    expect(currentStep(undefined, progress(all))).toBe('finished');
  });

  it('shows the step in the address when it is a step, else where the person stopped', () => {
    const some = progress({ workspace: 'done' });
    expect(currentStep('install', some)).toBe('install');
    expect(currentStep('finished', some)).toBe('finished');
    expect(currentStep('nonsense', some)).toBe('brand');
    expect(currentStep(undefined, some)).toBe('brand');
    expect(isStep('aikey')).toBe(true);
    expect(isStep('finished')).toBe(false);
    expect(isStep(3)).toBe(false);
  });

  it('counts what was done, skipped and left', () => {
    expect(tally(progress({ workspace: 'done', brand: 'done', engine: 'skipped' }))).toEqual({
      done: 2,
      skipped: 1,
      todo: 4,
      total: 7,
    });
  });

  it('moves along the steps in order, and stops at the ends', () => {
    expect(nextStep('workspace')).toBe('brand');
    expect(nextStep('install')).toBe('team');
    expect(nextStep('team')).toBeNull();
    expect(previousStep('brand')).toBe('workspace');
    expect(previousStep('workspace')).toBeNull();
  });
});

describe('where the chat may go', () => {
  it('lists each platform once, each with a name for people to read', () => {
    const ids = PLATFORMS.map((platform) => platform.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(setupEn.install.platforms[id], id).toBeTruthy();
    }
    expect(Object.keys(setupEn.install.platforms).sort()).toEqual([...ids].sort());
  });

  it('knows a platform by its name, and links its guide by file name', () => {
    expect(isPlatform('shopify')).toBe(true);
    expect(isPlatform('myspace')).toBe(false);
    expect(guideSlug('google-tag-manager')).toBe('google-tag-manager');
  });

  // The guides are written in docs/guide/integrations. Where that folder is there, every platform
  // in the picker must have its guide; a missing one would be a broken link in the setup guide.
  const folder = fileURLToPath(new URL('../../../docs/guide/integrations', import.meta.url));
  it.skipIf(!existsSync(folder))('has a written guide for every platform it offers', () => {
    const written = new Set(readdirSync(folder).map((file) => file.replace(/\.md$/, '')));
    const missing = PLATFORMS.filter((platform) => !written.has(platform.slug)).map((p) => p.slug);
    expect(missing).toEqual([]);
  });
});

describe('the website a person types', () => {
  it('turns what people type into the address the chat may load on', () => {
    expect(websiteOf('noor.example')).toEqual({ origin: 'https://noor.example', invalid: null });
    expect(websiteOf('https://noor.example/shop?x=1')).toEqual({
      origin: 'https://noor.example',
      invalid: null,
    });
    expect(websiteOf('  HTTPS://Noor.Example/  ')).toEqual({
      origin: 'https://noor.example',
      invalid: null,
    });
    expect(websiteOf('http://localhost:3000')).toEqual({
      origin: 'http://localhost:3000',
      invalid: null,
    });
  });

  it('leaves an empty box empty, and says what could not be read', () => {
    expect(websiteOf('')).toEqual({ origin: null, invalid: null });
    expect(websiteOf('   ')).toEqual({ origin: null, invalid: null });
    expect(websiteOf('noor')).toEqual({ origin: null, invalid: 'noor' });
    expect(websiteOf('ftp://noor.example')).toEqual({
      origin: null,
      invalid: 'ftp://noor.example',
    });
    expect(websiteOf('not a website')).toEqual({ origin: null, invalid: 'not a website' });
  });
});

// ------------------------------------------------------------------ customer identity keys

describe('customer identity keys', () => {
  it('accepts a key name the gateway accepts', () => {
    expect(isKeyName('shop-2026_a.1')).toBe(true);
    expect(isKeyName('a'.repeat(64))).toBe(true);
    expect(isKeyName('a'.repeat(65))).toBe(false);
    expect(isKeyName('has space')).toBe(false);
    expect(isKeyName('')).toBe(false);
  });

  it('reads a public key pasted as JSON', () => {
    expect(parseJwk('{"kty":"EC","crv":"P-256","x":"a","y":"b"}')).toEqual({
      jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    });
  });

  it('says what is wrong with something that is not a key', () => {
    expect(parseJwk('not json')).toEqual({ problem: 'json' });
    expect(parseJwk('[1,2]')).toEqual({ problem: 'object' });
    expect(parseJwk('"text"')).toEqual({ problem: 'object' });
    expect(parseJwk('null')).toEqual({ problem: 'object' });
  });

  it('never takes a private key, whatever its type', () => {
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']) {
      expect(
        parseJwk(JSON.stringify({ kty: 'RSA', n: 'a', e: 'AQAB', [member]: 'secret' })),
      ).toEqual({
        problem: 'private',
      });
    }
  });
});

describe('who can be added to a team', () => {
  const member = (id: string, status: 'active' | 'suspended' = 'active') =>
    ({ id, status, displayName: id }) as Parameters<typeof addable>[0][number];

  it('is active staff who are not in the team already', () => {
    const team = { members: [{ staffMemberId: 'staff_a', displayName: 'A' }] };
    const everyone = [member('staff_a'), member('staff_b'), member('staff_c', 'suspended')];
    expect(addable(everyone, team).map((m) => m.id)).toEqual(['staff_b']);
    expect(addable([], team)).toEqual([]);
  });
});
