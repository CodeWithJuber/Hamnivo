/**
 * Studio text for the command palette (HNV-03-05), in English, the source language. Page names
 * come from the menu's own text; only the palette's frame is here. Merged under `palette`.
 */
export const paletteEn = {
  /** The header button's accessible name; its visible text is `button`, which this begins with. */
  open: 'Search pages',
  button: 'Search',
  title: 'Go to a page',
  description: 'Type to find a page you can open. Use the arrow keys to choose, Enter to open it.',
  placeholder: 'Type a page name, such as Knowledge or Team and access',
  empty: 'No page matches “{{query}}”.',
  emptyHint: 'Try another word. Only pages you can open are listed.',
  current: 'You are here',
  account: 'Your account',
  hint: {
    move: 'to move',
    open: 'to open',
    close: 'to close',
  },
} as const;

type Strings<T> = { [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
/** Every locale has exactly the English keys; TypeScript reports a missing one. */
export type PaletteTranslation = Strings<typeof paletteEn>;
