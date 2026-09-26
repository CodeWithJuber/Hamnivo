/**
 * Hamnivo design tokens. Source: docs/design/Design-System.md (ink–ivory–coral).
 * `assets/tokens.css` and `assets/theme.css` are generated from this file (scripts/css.ts);
 * tests verify every text and UI colour pair used by the semantic tokens meets WCAG 2.2 AA.
 */

/** Core palette from the design kit. */
export const palette = {
  ink: '#192A30',
  ivory: '#F6F3EC',
  white: '#FFFFFF',
  /** Active indicator, selection edges, decoration. Never small text (3.80:1 on white). */
  coral: '#E45136',
  /** Text-bearing coral fills (badges, tenant-accent buttons): 5.2:1 with white text. */
  coralStrong: '#C2411F',
  /** Links and errors with text/icons. */
  rust: '#A22F20',
  /** Success foreground on a light surface. */
  sage: '#26724B',
  /** Caution foreground on a light surface. */
  amber: '#855B12',
} as const;

export type ThemeName = 'light' | 'dark';

/** Semantic colour roles. Every role is defined for both themes. */
export interface SemanticColors {
  bg: string;
  surface: string;
  surfaceMuted: string;
  surfaceSunken: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  border: string;
  borderInput: string;
  focus: string;
  primary: string;
  primaryHover: string;
  onPrimary: string;
  accent: string;
  accentStrong: string;
  onAccentStrong: string;
  accentSubtle: string;
  link: string;
  danger: string;
  dangerSubtle: string;
  onDanger: string;
  success: string;
  successSubtle: string;
  warning: string;
  warningSubtle: string;
  info: string;
  infoSubtle: string;
  laneInternal: string;
  laneInternalBorder: string;
  laneAgentWork: string;
  laneAgentWorkBorder: string;
  overlay: string;
}

export const colors: Record<ThemeName, SemanticColors> = {
  light: {
    bg: palette.ivory,
    surface: palette.white,
    surfaceMuted: '#FBF9F4',
    surfaceSunken: '#EFEBE2',
    text: palette.ink,
    textSecondary: '#3E5058',
    textMuted: '#5B6A70',
    textInverse: palette.ivory,
    border: '#E3DDD1',
    borderInput: '#928B80',
    focus: palette.ink,
    primary: palette.ink,
    primaryHover: '#24363D',
    onPrimary: palette.white,
    accent: palette.coral,
    accentStrong: palette.coralStrong,
    onAccentStrong: palette.white,
    accentSubtle: '#FDF0EC',
    link: palette.rust,
    danger: palette.rust,
    dangerSubtle: '#FBEDEA',
    onDanger: palette.white,
    success: palette.sage,
    successSubtle: '#E8F3EC',
    warning: palette.amber,
    warningSubtle: '#FBF3E2',
    info: '#34474F',
    infoSubtle: '#EEF1F2',
    laneInternal: '#FBF3E2',
    laneInternalBorder: palette.amber,
    laneAgentWork: '#EEF1F2',
    laneAgentWorkBorder: '#4A5B62',
    overlay: 'rgba(25, 42, 48, 0.48)',
  },
  dark: {
    bg: '#0F1A1E',
    surface: '#16242A',
    surfaceMuted: '#1B2C33',
    surfaceSunken: '#0B1417',
    text: '#F2EFE8',
    textSecondary: '#C9D1D4',
    textMuted: '#9AA7AC',
    textInverse: palette.ink,
    border: '#2A3B42',
    borderInput: '#6B7E86',
    focus: palette.ivory,
    primary: palette.ivory,
    primaryHover: '#E7E2D6',
    onPrimary: palette.ink,
    accent: palette.coral,
    accentStrong: '#F07A62',
    onAccentStrong: palette.ink,
    accentSubtle: '#3A221C',
    link: '#F29A87',
    danger: '#F08C7A',
    dangerSubtle: '#3A1F1B',
    onDanger: palette.ink,
    success: '#6CC495',
    successSubtle: '#13301F',
    warning: '#E3B55A',
    warningSubtle: '#33270F',
    info: '#B7C4C9',
    infoSubtle: '#1F3139',
    laneInternal: '#33270F',
    laneInternalBorder: '#E3B55A',
    laneAgentWork: '#1F3139',
    laneAgentWorkBorder: '#9AA7AC',
    overlay: 'rgba(5, 10, 12, 0.64)',
  },
};

/**
 * Colour pairs the UI actually renders, with the contrast they must meet. Tests assert each one,
 * so adding a role without a checked pairing is caught in review.
 */
export const contrastPairs: readonly {
  fg: keyof SemanticColors;
  bg: keyof SemanticColors;
  use: 'text' | 'ui';
}[] = [
  { fg: 'text', bg: 'bg', use: 'text' },
  { fg: 'text', bg: 'surface', use: 'text' },
  { fg: 'text', bg: 'surfaceMuted', use: 'text' },
  { fg: 'text', bg: 'surfaceSunken', use: 'text' },
  { fg: 'textSecondary', bg: 'surface', use: 'text' },
  { fg: 'textSecondary', bg: 'bg', use: 'text' },
  { fg: 'textMuted', bg: 'surface', use: 'text' },
  { fg: 'textMuted', bg: 'bg', use: 'text' },
  { fg: 'textMuted', bg: 'surfaceMuted', use: 'text' },
  { fg: 'onPrimary', bg: 'primary', use: 'text' },
  { fg: 'onPrimary', bg: 'primaryHover', use: 'text' },
  { fg: 'onAccentStrong', bg: 'accentStrong', use: 'text' },
  { fg: 'onDanger', bg: 'danger', use: 'text' },
  { fg: 'link', bg: 'surface', use: 'text' },
  { fg: 'link', bg: 'bg', use: 'text' },
  { fg: 'danger', bg: 'surface', use: 'text' },
  { fg: 'danger', bg: 'dangerSubtle', use: 'text' },
  { fg: 'success', bg: 'surface', use: 'text' },
  { fg: 'success', bg: 'successSubtle', use: 'text' },
  { fg: 'warning', bg: 'surface', use: 'text' },
  { fg: 'warning', bg: 'warningSubtle', use: 'text' },
  { fg: 'info', bg: 'infoSubtle', use: 'text' },
  { fg: 'text', bg: 'laneInternal', use: 'text' },
  { fg: 'text', bg: 'laneAgentWork', use: 'text' },
  { fg: 'text', bg: 'accentSubtle', use: 'text' },
  { fg: 'borderInput', bg: 'surface', use: 'ui' },
  { fg: 'borderInput', bg: 'bg', use: 'ui' },
  { fg: 'focus', bg: 'surface', use: 'ui' },
  { fg: 'focus', bg: 'bg', use: 'ui' },
  { fg: 'accent', bg: 'surface', use: 'ui' },
  { fg: 'laneInternalBorder', bg: 'surface', use: 'ui' },
  { fg: 'laneAgentWorkBorder', bg: 'surface', use: 'ui' },
];

export const typography = {
  fontSans:
    "'DM Sans Variable', 'DM Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', system-ui, -apple-system, 'Segoe UI', sans-serif",
  /** Urdu reads best in Nastaliq; Arabic-script fallback keeps glyph coverage. */
  fontUrdu: "'Noto Nastaliq Urdu', 'Noto Sans Arabic', 'DM Sans Variable', serif",
  fontMono: "ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace",
  /** rem-based so browser text enlargement scales the UI (WCAG 1.4.4). */
  size: {
    xs: ['0.75rem', '1rem'],
    sm: ['0.8125rem', '1.25rem'],
    base: ['0.875rem', '1.375rem'],
    md: ['1rem', '1.5rem'],
    lg: ['1.125rem', '1.625rem'],
    xl: ['1.25rem', '1.75rem'],
    '2xl': ['1.5rem', '2rem'],
    '3xl': ['1.75rem', '2.25rem'],
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
} as const;

/** Spacing scale in px (4, 8, 12, 16, 24, 32) — Tailwind's 0.25rem base produces these steps. */
export const spacing = [4, 8, 12, 16, 24, 32] as const;

export const radius = {
  sm: '6px',
  /** Inputs. */
  md: '8px',
  /** Menus and dialogs. */
  lg: '12px',
  /** Customer widget container. */
  xl: '16px',
  full: '9999px',
} as const;

export const controlHeight = {
  /** Desktop minimum nominal height. */
  desktop: '40px',
  /** Touch target goal. */
  touch: '44px',
} as const;

export const motion = {
  fast: '120ms',
  base: '160ms',
  slow: '180ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

export const shadow = {
  sm: '0 1px 2px rgba(25, 42, 48, 0.06)',
  md: '0 4px 16px rgba(25, 42, 48, 0.10)',
  lg: '0 16px 48px rgba(25, 42, 48, 0.18)',
} as const;

export const zIndex = {
  dropdown: 40,
  sticky: 50,
  drawer: 60,
  dialog: 70,
  toast: 80,
  tooltip: 90,
} as const;

/** Layout frames from the design kit (used by e2e tests and previews). */
export const frames = {
  agentWorkspace: { width: 1440, height: 1000 },
  admin: { width: 1440, height: 1000 },
  widget: { width: 390, height: 620 },
  mobile: { width: 390, height: 844 },
  desktopCanonical: { width: 1440, height: 1024 },
  checkWidths: [320, 360, 390, 768, 1024, 1440, 1920],
} as const;
