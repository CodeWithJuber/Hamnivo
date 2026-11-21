import { WidgetAppearance } from '@hamnivo/contracts';

/**
 * The schema of a draft appearance from Studio's test chat. It loads only in that test chat (see
 * preview.ts), so the schema and zod stay out of every visitor's first open.
 */
export function checkAppearance(value: unknown): WidgetAppearance | null {
  const checked = WidgetAppearance.safeParse(value);
  return checked.success ? checked.data : null;
}
