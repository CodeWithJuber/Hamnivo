import { bestOn, formatRatio, type ThemeIssue, validateTheme } from '@hamnivo/brand';
import { WidgetAppearance } from '@hamnivo/contracts';

/**
 * How a brand's chat looks (W03). The chat panel is white with ink text, so the main colour is
 * checked against those two (the repo's own check, `validateTheme`): readable text on it, and
 * visible against a white page.
 */

export const PANEL_SURFACE = '#FFFFFF';
export const PANEL_TEXT = '#192A30';
/** What text on the main colour may be: white or ink, whichever reads better. */
const TEXT_ON_COLOUR = ['#FFFFFF', PANEL_TEXT] as const;

/** The colour of text placed on the main colour. */
export function onPrimary(primaryColor: string): string {
  return bestOn(primaryColor, TEXT_ON_COLOUR);
}

/** A brand's stored appearance, or the defaults when it has none or it no longer reads. */
export function parseAppearance(value: unknown): WidgetAppearance {
  const result = WidgetAppearance.safeParse(value ?? {});
  return result.success ? result.data : WidgetAppearance.parse({});
}

/** What is wrong with a main colour, if anything. */
export function colourIssues(primaryColor: string): ThemeIssue[] {
  return validateTheme({
    accent: primaryColor,
    onAccent: onPrimary(primaryColor),
    surface: PANEL_SURFACE,
    text: PANEL_TEXT,
  });
}

/** A failing colour in words for the colour field. */
export function colourProblem(issue: ThemeIssue): string {
  const ratio = formatRatio(issue.ratio);
  return issue.field === 'accent'
    ? `This colour is too close to white to stand out on a page. Pick a darker one (contrast ${ratio}; at least ${issue.required}:1 is needed).`
    : `Text on this colour is hard to read. Pick a darker or a lighter colour (contrast ${ratio}; at least ${issue.required}:1 is needed).`;
}
