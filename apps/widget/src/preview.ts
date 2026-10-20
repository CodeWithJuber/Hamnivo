import { WidgetAppearance, type WidgetConfig } from '@hamnivo/contracts';
/** Only Studio's test iframe accepts a draft. It never changes stored brand configuration. */
export function readPreview(
  event: MessageEvent,
  parent: Window,
  origin: string | null,
  test: boolean,
): WidgetAppearance | null {
  if (
    !test ||
    !origin ||
    event.source !== parent ||
    event.origin !== origin ||
    event.data?.source !== 'hamnivo-studio-preview'
  )
    return null;
  const checked = WidgetAppearance.safeParse(event.data.appearance);
  return checked.success ? checked.data : null;
}
export function previewTextColour(hex: string): string {
  const luminance = (colour: string) => {
    const values = [1, 3, 5]
      .map((offset) => Number.parseInt(colour.slice(offset, offset + 2), 16) / 255)
      .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4));
    return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
  };
  const light = luminance(hex);
  const ink = luminance('#192A30');
  return 1.05 / (light + 0.05) >= (light + 0.05) / (ink + 0.05) ? '#FFFFFF' : '#192A30';
}
export function previewConfig(config: WidgetConfig, appearance: WidgetAppearance): WidgetConfig {
  const copy = { ...config.copy };
  for (const locale of ['en', 'ar', 'hi', 'ur'] as const)
    copy[locale] = {
      ...copy[locale],
      greeting: appearance.greeting?.[locale] || appearance.greeting?.en || copy[locale].greeting,
      offlineMessage:
        appearance.offlineText?.[locale] ||
        appearance.offlineText?.en ||
        copy[locale].offlineMessage,
    };
  return {
    ...config,
    brand: {
      ...config.brand,
      accent: appearance.primaryColor,
      onAccent: previewTextColour(appearance.primaryColor),
      radius: appearance.radius,
      logoUrl: appearance.logoUrl,
      fontFamily: appearance.fontFamily,
      showBranding: appearance.showBranding,
    },
    copy,
    features: { ...config.features, csat: appearance.csat },
    privacyPolicyUrl: appearance.privacyUrl,
  };
}
