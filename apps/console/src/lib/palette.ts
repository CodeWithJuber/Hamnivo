/**
 * The command palette (HNV-03-05): every page a person can open, found by typing, from anywhere
 * in Studio with ⌘K or Ctrl+K. It lists the menu's pages (lib/nav.ts) plus the few pages that are
 * reached from a button instead of the menu, each with the permission of that button. Like the
 * menu, this only decides what is listed; the gateway still checks every request.
 */
import {
  type Can,
  menuFor,
  NAV_GROUPS,
  type NavFeatures,
  type NavGroupId,
  type NavPath,
} from './nav';

/** Pages reached from a button rather than the menu. */
export type ExtraPath =
  | '/onboarding'
  | '/visitors'
  | '/saved-replies'
  | '/blocked'
  | '/stop-ai'
  | '/account'
  | '/tenants';

export type PalettePath = NavPath | ExtraPath;

/** The menu's groups, and the account area at the bottom of the menu. */
export type PaletteGroupId = NavGroupId | 'account';

interface Extra {
  to: ExtraPath;
  group: PaletteGroupId;
  /** Listed when the person holds this permission (the button it stands for asks the same). */
  permission?: string;
}

/** In the order they are listed, after the menu's own pages of the same group. */
export const PALETTE_EXTRAS: readonly Extra[] = [
  // Home's "Open guided setup" button.
  { to: '/onboarding', group: 'home', permission: 'brands.manage' },
  // The buttons above the list of chats in the inbox.
  { to: '/visitors', group: 'inbox', permission: 'conversations.read' },
  { to: '/saved-replies', group: 'inbox', permission: 'inbox.manage' },
  { to: '/blocked', group: 'inbox', permission: 'visitors.block' },
  // The red Stop AI button in the header.
  { to: '/stop-ai', group: 'ai', permission: 'agents.publish' },
  // The account area: everyone has it.
  { to: '/account', group: 'account' },
  { to: '/tenants', group: 'account' },
];

const ORDER: readonly PaletteGroupId[] = [...NAV_GROUPS.map((group) => group.id), 'account'];

export interface PaletteSection {
  id: PaletteGroupId;
  items: PalettePath[];
}

/** What this person can find, grouped as the menu is; a group with nothing in it is left out. */
export function paletteSections(can: Can, features: NavFeatures): PaletteSection[] {
  const found = new Map<PaletteGroupId, PalettePath[]>();
  for (const group of menuFor(can, features)) {
    found.set(
      group.id,
      group.routes.map((route) => route.to),
    );
  }
  for (const extra of PALETTE_EXTRAS) {
    if (extra.permission && !can(extra.permission)) continue;
    found.set(extra.group, [...(found.get(extra.group) ?? []), extra.to]);
  }
  return ORDER.flatMap((id) => {
    const items = found.get(id);
    return items?.length ? [{ id, items }] : [];
  });
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();

/**
 * How well a page matches what was typed, for the palette's list (0 hides it). Every typed word
 * must appear in one of the page's names: its own name (`keywords[0]`), its group's name or its
 * English name. Letters scattered across words do not count, so "billing" never brings up
 * "Brands and install". The page's own name ranks first, starting with what was typed best.
 */
export function paletteScore(_value: string, search: string, keywords: readonly string[] = []) {
  const query = normalize(search);
  if (!query) return 1;
  const names = keywords.map(normalize);
  const words = query.split(/\s+/);
  if (!words.every((word) => names.some((name) => name.includes(word)))) return 0;
  const own = names[0] ?? '';
  if (own.startsWith(query)) return 1;
  if (own.split(/\s+/).some((word) => word.startsWith(query))) return 0.9;
  if (own.includes(query)) return 0.8;
  if (names.some((name) => name.startsWith(query))) return 0.6;
  return 0.4;
}

/**
 * ⌘K on a Mac, Ctrl+K elsewhere (both are accepted everywhere). The physical key counts, so the
 * shortcut also works with an Arabic, Hindi or Urdu keyboard layout, where the key types another
 * letter.
 */
export function isPaletteShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false;
  return event.code === 'KeyK' || event.key.toLowerCase() === 'k';
}

/** Whether this device labels the shortcut ⌘K (Apple) rather than Ctrl K. */
export function usesCommandKey(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
