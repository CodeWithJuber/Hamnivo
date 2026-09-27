import { colors, palette } from '@hamnivo/brand';

const inkBand = {
  '--ink-bg': palette.ink,
  '--ink-text': colors.dark.text,
  '--ink-text-secondary': colors.dark.textSecondary,
  '--ink-focus': colors.dark.focus,
  '--ink-border': colors.dark.borderInput,
  '--ink-primary': colors.dark.primary,
  '--ink-primary-hover': colors.dark.primaryHover,
  '--ink-on-primary': colors.dark.onPrimary,
  '--ink-raised': colors.light.primaryHover,
};

/**
 * The header, hero, footer and code blocks sit on ink. Their text and controls use the dark
 * theme's roles, which the brand defines for dark surfaces, so every colour stays a brand token.
 * Emitted as custom properties in the page head; global.css maps them to Tailwind colours.
 */
export const inkBandCss = `:root{${Object.entries(inkBand)
  .map(([name, value]) => `${name}:${value}`)
  .join(';')}}`;
