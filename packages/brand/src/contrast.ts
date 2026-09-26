/**
 * WCAG 2.2 contrast utilities. Used by the design system tests and by the widget theme
 * validator (blueprint W03: "accessible contrast validation") on both client and server.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(hex: string): Rgb {
  const match = HEX.exec(hex.trim());
  if (!match?.[1]) throw new TypeError(`Invalid hex colour: ${hex}`);
  const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join('') : match[1];
  return {
    r: Number.parseInt(digits.slice(0, 2), 16),
    g: Number.parseInt(digits.slice(2, 4), 16),
    b: Number.parseInt(digits.slice(4, 6), 16),
  };
}

export function isHexColor(value: string): boolean {
  return HEX.test(value.trim());
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance per WCAG 2.x. */
export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === 'string' ? parseHex(color) : color;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio between two opaque colours, from 1 to 21. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Rounds down so a reported "4.49" never displays as passing 4.5. */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
}

export type ContrastUse = 'text' | 'large-text' | 'ui';

/** WCAG 2.2 AA thresholds: 4.5:1 body text, 3:1 large text and UI components/graphics. */
export const AA_THRESHOLD: Record<ContrastUse, number> = {
  text: 4.5,
  'large-text': 3,
  ui: 3,
};

export function meetsAA(foreground: string, background: string, use: ContrastUse): boolean {
  return contrastRatio(foreground, background) >= AA_THRESHOLD[use];
}

export interface ThemeInput {
  /** Tenant-chosen accent (buttons, launcher, links). */
  accent: string;
  /** Text colour placed on the accent (usually white or ink). */
  onAccent: string;
  /** Surface the accent sits on (widget panel background). */
  surface: string;
  /** Body text colour on the surface. */
  text: string;
}

export interface ThemeIssue {
  field: keyof ThemeInput;
  pair: [string, string];
  ratio: number;
  required: number;
  use: ContrastUse;
  message: string;
}

/**
 * Validates a tenant theme. Every pair that carries text must reach 4.5:1; the accent must be
 * distinguishable from the surface as a UI component (3:1). Returns the failing pairs with a
 * plain-language message the widget studio shows next to the offending field.
 */
export function validateTheme(theme: ThemeInput): ThemeIssue[] {
  for (const [field, value] of Object.entries(theme) as [keyof ThemeInput, string][]) {
    if (!isHexColor(value)) {
      return [
        {
          field,
          pair: [value, value],
          ratio: 0,
          required: 0,
          use: 'ui',
          message: `${field} must be a hex colour such as #192A30`,
        },
      ];
    }
  }
  const checks: {
    field: keyof ThemeInput;
    fg: string;
    bg: string;
    use: ContrastUse;
    what: string;
  }[] = [
    { field: 'onAccent', fg: theme.onAccent, bg: theme.accent, use: 'text', what: 'Button text' },
    { field: 'text', fg: theme.text, bg: theme.surface, use: 'text', what: 'Body text' },
    { field: 'accent', fg: theme.accent, bg: theme.surface, use: 'ui', what: 'Accent' },
  ];
  const issues: ThemeIssue[] = [];
  for (const check of checks) {
    const ratio = contrastRatio(check.fg, check.bg);
    const required = AA_THRESHOLD[check.use];
    if (ratio < required) {
      issues.push({
        field: check.field,
        pair: [check.fg, check.bg],
        ratio,
        required,
        use: check.use,
        message: `${check.what} contrast is ${formatRatio(ratio)}; at least ${required}:1 is required.`,
      });
    }
  }
  return issues;
}

/** Picks whichever of the candidates gives the highest contrast on the background. */
export function bestOn(background: string, candidates: readonly string[]): string {
  let best = candidates[0];
  let bestRatio = -1;
  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }
  if (!best) throw new RangeError('bestOn needs at least one candidate');
  return best;
}
