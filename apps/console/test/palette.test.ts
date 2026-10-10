import { presetPermissions } from '@hamnivo/policy';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n, LOCALES } from '../src/i18n';
import { paletteAr } from '../src/i18n/palette/ar';
import { paletteEn } from '../src/i18n/palette/en';
import { paletteHi } from '../src/i18n/palette/hi';
import { paletteUr } from '../src/i18n/palette/ur';
import { menuFor, NAV_GROUPS } from '../src/lib/nav';
import { navLabels } from '../src/lib/nav-labels';
import {
  isPaletteShortcut,
  PALETTE_EXTRAS,
  paletteScore,
  paletteSections,
} from '../src/lib/palette';

beforeAll(async () => {
  await initI18n('en');
});

const canFrom = (permissions: readonly string[]) => (permission: string) =>
  permissions.includes(permission);

const paths = (permissions: readonly string[]) =>
  paletteSections(canFrom(permissions)).flatMap((section) => section.items);

describe('what the palette lists', () => {
  it('lists every page of the menu an owner sees, grouped and in the menu’s order', () => {
    const owner = canFrom(presetPermissions('owner'));
    const sections = paletteSections(owner);
    expect(sections.map((section) => section.id)).toEqual([
      'home',
      'inbox',
      'ai',
      'sales',
      'reports',
      'settings',
      'account',
    ]);
    // Each group starts with exactly the menu's pages, in the menu's order.
    for (const group of menuFor(owner)) {
      const section = sections.find((s) => s.id === group.id);
      expect(section?.items.slice(0, group.routes.length)).toEqual(
        group.routes.map((route) => route.to),
      );
    }
    // All of the menu's pages, plus every page behind a button, each once.
    const listed = sections.flatMap((section) => section.items);
    const everyPage = NAV_GROUPS.flatMap((group) => group.routes.map((route) => route.to));
    expect(listed).toEqual(expect.arrayContaining(everyPage));
    expect(listed).toEqual(expect.arrayContaining(PALETTE_EXTRAS.map((extra) => extra.to)));
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('lists the pages behind buttons only for people the button is shown to', () => {
    const agent = paths(presetPermissions('agent'));
    expect(agent).toContain('/visitors');
    expect(agent).not.toContain('/saved-replies');
    expect(agent).not.toContain('/blocked');
    expect(agent).not.toContain('/stop-ai');
    expect(agent).not.toContain('/onboarding');
    expect(agent).not.toContain('/models');

    const supervisor = paths(presetPermissions('supervisor'));
    expect(supervisor).toEqual(expect.arrayContaining(['/saved-replies', '/blocked']));
    expect(supervisor).not.toContain('/stop-ai');
  });

  it('always offers the account pages, and nothing a person cannot open', () => {
    expect(paletteSections(canFrom([]))).toEqual([
      { id: 'home', items: ['/overview'] },
      { id: 'account', items: ['/account', '/tenants'] },
    ]);
    expect(paths(['conversations.read'])).toEqual([
      '/overview',
      '/inbox',
      '/visitors',
      '/account',
      '/tenants',
    ]);
  });
});

describe('matching what was typed', () => {
  const billing = ['Plan and billing', 'Settings', 'Plan and billing', 'Settings'];
  const brands = ['Brands and install', 'Settings', 'Brands and install', 'Settings'];

  it('needs every typed word in one of the names, not letters scattered across them', () => {
    expect(paletteScore('/settings/billing', 'billing', billing)).toBeGreaterThan(0);
    expect(paletteScore('/brands', 'billing', brands)).toBe(0);
    expect(paletteScore('/brands', 'brand install', brands)).toBeGreaterThan(0);
    expect(paletteScore('/brands', 'brand billing', brands)).toBe(0);
  });

  it('ranks the page’s own name first, starting with what was typed best', () => {
    const starts = paletteScore('/settings/billing', 'plan', billing);
    const word = paletteScore('/settings/billing', 'billing', billing);
    const inside = paletteScore('/settings/billing', 'illing', billing);
    const group = paletteScore('/brands', 'settings', brands);
    expect(starts).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(group);
    expect(group).toBeGreaterThan(0);
  });

  it('ignores case and surrounding space, and matches other scripts', () => {
    expect(paletteScore('/brands', '  BRANDS ', brands)).toBe(1);
    expect(paletteScore('/knowledge', 'المعر', ['المعرفة', 'مساعد الذكاء', 'Knowledge'])).toBe(1);
    expect(paletteScore('/knowledge', '', ['Knowledge'])).toBe(1);
  });
});

describe('the shortcut', () => {
  const press = (init: Partial<KeyboardEvent>) =>
    isPaletteShortcut({
      key: 'k',
      code: 'KeyK',
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    });

  it('is ⌘K or Ctrl+K, and nothing else', () => {
    expect(press({ metaKey: true })).toBe(true);
    expect(press({ ctrlKey: true })).toBe(true);
    expect(press({ key: 'K', ctrlKey: true })).toBe(true);
    expect(press({})).toBe(false);
    expect(press({ ctrlKey: true, shiftKey: true })).toBe(false);
    expect(press({ ctrlKey: true, altKey: true })).toBe(false);
    expect(press({ ctrlKey: true, key: 'j', code: 'KeyJ' })).toBe(false);
  });

  it('works by the physical key, so an Arabic or Urdu keyboard layout opens it too', () => {
    expect(press({ ctrlKey: true, key: 'ن', code: 'KeyK' })).toBe(true);
  });
});

type Tree = { readonly [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe('palette text in every language', () => {
  const english = flatten(paletteEn);

  for (const [locale, tree] of Object.entries({ ar: paletteAr, hi: paletteHi, ur: paletteUr })) {
    it(`${locale}: every key, the same placeholders and no empty text`, () => {
      const strings = flatten(tree);
      expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
      for (const [key, text] of Object.entries(strings)) {
        expect(text.trim(), `${locale}.${key}`).not.toBe('');
        expect(placeholders(text), `${locale}.${key}`).toEqual(placeholders(english[key] ?? ''));
      }
    });
  }

  it('the header button’s name contains its visible text, in every language', () => {
    // Speech input users say what they see (WCAG 2.5.3). Hindi and Urdu put the verb last, so
    // the visible word is inside the name rather than at its start.
    for (const tree of [paletteEn, paletteAr, paletteHi, paletteUr]) {
      expect(tree.open).toContain(tree.button);
    }
  });

  it('names every page it can list, in every language', () => {
    const owner = canFrom(presetPermissions('owner'));
    for (const locale of LOCALES) {
      const labels = navLabels(i18next.getFixedT(locale));
      const names: Record<string, string> = { ...labels.pages, ...labels.extras };
      for (const section of paletteSections(owner)) {
        for (const to of section.items) {
          const label = names[to] ?? '';
          expect(label.trim(), `${locale} ${to}`).not.toBe('');
          // A missing key comes back as the key itself.
          expect(label, `${locale} ${to}`).not.toMatch(/^[a-zA-Z]+(\.[a-zA-Z]+)+$/);
        }
      }
    }
  });
});
