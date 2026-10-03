/**
 * How a brand's chat looks (W03): its main colour and how round its corners are. The gateway has
 * already checked that text on the colour is readable and that the colour shows on a white page,
 * and sends the text colour with it; this only puts them to use, by setting the design tokens the
 * chat is drawn from. A brand that kept Hamnivo's own look changes nothing.
 */

export interface BrandLook {
  /** Main colour, `#RRGGBB`. */
  accent: string;
  /** Colour of text on it, `#RRGGBB`. */
  onAccent: string;
  /** Corner radius in pixels, 0 to 24; 12 is the design's own. */
  radius: number;
}

/** The look Hamnivo's tokens already have. */
export const DEFAULT_LOOK: BrandLook = { accent: '#192A30', onAccent: '#FFFFFF', radius: 12 };

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
 * The tokens a look changes, as CSS custom properties. The hover colour moves a little away from
 * the main colour, towards white on a dark colour and towards black on a light one, so a pressed
 * button stays as readable as a resting one. Radii keep the design's proportions (6, 8, 12 and 16
 * pixels at the default) and scale with the brand's choice.
 */
export function themeVariables(look: BrandLook): Record<string, string> {
  const whiteText = look.onAccent.toUpperCase() === '#FFFFFF';
  const scale = Math.min(24, Math.max(0, look.radius)) / DEFAULT_LOOK.radius;
  const px = (pixels: number) => `${Math.round(pixels * scale * 10) / 10}px`;
  return {
    '--hv-primary': look.accent,
    '--hv-primary-hover': mix(look.accent, whiteText ? '#FFFFFF' : '#000000', 0.12),
    '--hv-on-primary': look.onAccent,
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
    look.radius === DEFAULT_LOOK.radius
  );
}

/** What `applyTheme` needs of an element: its inline style. */
export interface Themable {
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): unknown };
}

/** Sets the brand's look on the page's root element, or takes it off again for the default look. */
export function applyTheme(root: Themable, look: BrandLook): void {
  const variables = themeVariables(look);
  const set = !isDefaultLook(look);
  for (const [name, value] of Object.entries(variables)) {
    if (set) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  }
}
