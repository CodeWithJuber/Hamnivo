/**
 * Whether the page the chat sits on is light or dark, so the chat can match it instead of the
 * visitor's device. What is seen decides: the page's own background first, and where the page
 * paints none, the colour scheme it declares. Pure, so it is tested without a browser.
 */

export type Scheme = 'light' | 'dark';

/**
 * How light a computed CSS colour is (0 black to 1 white) and how solid (0 to 1); null for a
 * colour it cannot read. Browsers report `rgb()` for most colours, and newer notations
 * (`oklch()`, `lab()`, `color(srgb …)`) as they were written.
 */
export function tone(colour: string): { light: number; alpha: number } | null {
  const parts = /^(rgb|okl|l|color)[a-z]*\((.+)\)$/.exec(colour.trim().toLowerCase());
  if (!parts) return null;
  const kind = parts[1];
  // Channels run to 255 in rgb(), lightness to 100 in lab() and lch(), everything else to 1.
  const whole = kind === 'rgb' ? 255 : kind === 'l' ? 100 : 1;
  const read = (text: string | undefined, of: number) =>
    text === undefined
      ? undefined
      : text.endsWith('%')
        ? Number.parseFloat(text) / 100
        : Number(text) / of;
  const [body = '', slash] = (parts[2] ?? '').split('/');
  const values = body.match(/-?[\d.]+%?/g) ?? [];
  const [a = 0, b = 0, c = 0] = values.slice(0, 3).map((value) => read(value, whole) ?? 0);
  // Opacity is after a slash in the newer notation, the fourth number in the older one.
  const alpha = read(slash?.trim() ?? values[3], 1) ?? 1;
  // Lightness comes first in lab and lch colours; red, green and blue are weighed as the eye does.
  const light = kind === 'rgb' || kind === 'color' ? 0.299 * a + 0.587 * b + 0.114 * c : a;
  if (Number.isNaN(light) || Number.isNaN(alpha)) return null;
  const within = (value: number) => Math.min(1, Math.max(0, value));
  return { light: within(light), alpha: within(alpha) };
}

/**
 * Light or dark, from the backgrounds the page paints (the body's, then the root's) and, when
 * both let the browser's own canvas show through, from the colour scheme the page declares: a
 * page that declares only `dark` is dark, and one that declares both follows the device.
 */
export function schemeOf(
  backgrounds: readonly string[],
  colorScheme: string,
  deviceDark: boolean,
): Scheme {
  for (const background of backgrounds) {
    const seen = tone(background);
    if (seen && seen.alpha >= 0.5) return seen.light < 0.5 ? 'dark' : 'light';
  }
  const declared = colorScheme.toLowerCase();
  const dark = /\bdark\b/.test(declared);
  const light = /\blight\b/.test(declared);
  return dark && (!light || deviceDark) ? 'dark' : 'light';
}
