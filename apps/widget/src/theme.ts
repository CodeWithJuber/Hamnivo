/**
 * How a brand's chat looks (W03): its main colour and how round its corners are. The gateway has
 * already checked that text on the colour is readable and that the colour shows on a white page,
 * and sends the text colour with it; this only puts them to use, by setting the design tokens the
 * chat is drawn from. A brand that kept Hamnivo's own look changes nothing.
 *
 * The chat is light or dark by an explicit choice (`data-theme` on the page), never by the
 * visitor's device alone: the brand's choice first, then the website the chat sits on, and the
 * device only where the chat is a page of its own. On the dark chat the brand's colour is made
 * lighter until it stands out, since the gateway only checked it on white.
 */
import { bestOn, contrastRatio } from '@hamnivo/brand';

export type Scheme = 'light' | 'dark';
/** What a brand may choose: one of the two, or `auto` to follow the website. */
export type ThemeMode = Scheme | 'auto';

export interface BrandLook {
  /** Main colour, `#RRGGBB`. */
  accent: string;
  /** Colour of text on it, `#RRGGBB`. */
  onAccent: string;
  /** Corner radius in pixels, 0 to 24; 12 is the design's own. */
  radius: number;
  fontFamily?: 'system' | 'dm-sans' | 'noto-sans' | undefined;
}

/** The look Hamnivo's tokens already have. */
export const DEFAULT_LOOK: BrandLook = { accent: '#192A30', onAccent: '#FFFFFF', radius: 12 };

const INK = '#192A30';
/** The dark chat's panel colour (`--hv-surface` in the dark tokens). */
const DARK_SURFACE = '#16242A';
/** A control must stand out from what is behind it (WCAG 2.2, 1.4.11). */
const UI_CONTRAST = 3;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** `amount` (0 to 1) of `other` mixed into `colour`; both `#RRGGBB`. */
function mix(colour: string, other: string, amount: number): string {
  const from = HEX.exec(colour);
  const to = HEX.exec(other);
  if (!from || !to) return colour;
  const channel = (index: number) => {
    const a = Number.parseInt(from[index] ?? '0', 16);
    const b = Number.parseInt(to[index] ?? '0', 16);
    return Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(2)}${channel(3)}`.toUpperCase();
}

/**
 * The brand's colour for buttons and the visitor's own messages on the dark chat: the colour
 * itself when it stands out from the dark panel, otherwise lighter, step by step, until it does.
 */
export function darkAccent(accent: string): string {
  if (!HEX.test(accent)) return accent;
  let colour = accent.toUpperCase();
  for (let step = 0; step < 16 && contrastRatio(colour, DARK_SURFACE) < UI_CONTRAST; step += 1) {
    colour = mix(colour, '#FFFFFF', 0.12);
  }
  return colour;
}

/**
 * The tokens a look changes, as CSS custom properties. The hover colour moves a little away from
 * the main colour, towards white on a dark colour and towards black on a light one, so a pressed
 * button stays as readable as a resting one. Radii keep the design's proportions (6, 8, 12 and 16
 * pixels at the default) and scale with the brand's choice. The header keeps the brand's own
 * colour in both schemes; its far end moves away from the colour of its text, so the text never
 * gets harder to read along the way.
 */
export function themeVariables(look: BrandLook, scheme: Scheme = 'light'): Record<string, string> {
  const primary = scheme === 'dark' ? darkAccent(look.accent) : look.accent;
  const onPrimary =
    scheme === 'dark' && HEX.test(primary) ? bestOn(primary, ['#FFFFFF', INK]) : look.onAccent;
  const whiteText = onPrimary.toUpperCase() === '#FFFFFF';
  const whiteOnHeader = look.onAccent.toUpperCase() === '#FFFFFF';
  const scale = Math.min(24, Math.max(0, look.radius)) / DEFAULT_LOOK.radius;
  const px = (pixels: number) => `${Math.round(pixels * scale * 10) / 10}px`;
  return {
    '--hv-brand-font':
      look.fontFamily === 'system'
        ? 'system-ui, sans-serif'
        : look.fontFamily === 'noto-sans'
          ? '"Hamnivo Noto Sans", "Noto Sans", "Noto Sans Devanagari", "Noto Sans Arabic", sans-serif'
          : '"Hamnivo DM Sans", "DM Sans Variable", "Noto Sans Devanagari", "Noto Sans Arabic", sans-serif',
    '--hv-primary': primary,
    '--hv-primary-hover': mix(primary, whiteText ? '#FFFFFF' : '#000000', 0.12),
    '--hv-on-primary': onPrimary,
    '--hv-header-from': look.accent,
    '--hv-header-to': mix(look.accent, whiteOnHeader ? '#000000' : '#FFFFFF', 0.2),
    '--hv-header-fg': look.onAccent,
    '--hv-radius-sm': px(6),
    '--hv-radius-md': px(8),
    '--hv-radius-lg': px(12),
    '--hv-radius-xl': px(16),
  };
}

/** Whether a look is Hamnivo's own, so nothing needs to be overridden. */
export function isDefaultLook(look: BrandLook): boolean {
  return (
    look.accent.toUpperCase() === DEFAULT_LOOK.accent &&
    look.onAccent.toUpperCase() === DEFAULT_LOOK.onAccent &&
    (!look.fontFamily || look.fontFamily === 'dm-sans') &&
    look.radius === DEFAULT_LOOK.radius
  );
}

/** What `applyTheme` needs of an element: its inline style. */
export interface Themable {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

/** Sets the brand's look on the page's root element, or takes it off again for the default look. */
export function applyTheme(root: Themable, look: BrandLook, scheme: Scheme = 'light'): void {
  const variables = themeVariables(look, scheme);
  const set = !isDefaultLook(look);
  for (const [name, value] of Object.entries(variables)) {
    if (set) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}

/**
 * Light or dark, decided in order: the brand's own choice; for `auto`, what the website says
 * about itself (`hint`, from the loader); and where there is no website around the chat, the
 * visitor's device. A chat on a website that says nothing stays light, as every website is
 * until it says otherwise.
 */
export function resolveScheme(
  mode: ThemeMode | undefined,
  hint: Scheme | null,
  embedded: boolean,
  device: Scheme,
): Scheme {
  if (mode === 'light' || mode === 'dark') return mode;
  if (hint) return hint;
  return embedded ? 'light' : device;
}

/** `light` or `dark` from a query parameter or a message; anything else is no answer. */
export function schemeOf(value: unknown): Scheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}
