import { HamnivoMark } from '@hamnivo/ui/components/hamnivo-mark';
import { useEffect } from 'react';
import { usePublicBranding } from '../lib/branding';
/** Branding is resolved by the server's exact host mapping, never a tenant from a URL parameter. */
export function PortalBrand() {
  const portal = usePublicBranding().data?.portal;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {portal?.logoUrl ? (
        <img
          src={portal.logoUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="size-7 shrink-0 object-contain"
        />
      ) : (
        <HamnivoMark className="size-7" />
      )}
      <span className="truncate text-lg font-semibold text-text">
        <bdi>{portal?.displayName ?? 'Hamnivo'}</bdi>
      </span>
      {portal?.showBranding !== false ? (
        <span className="text-sm text-text-secondary">Studio</span>
      ) : null}
    </span>
  );
}
/** Mounted once inside the query provider so opening the mobile menu cannot change the theme. */
export function PortalTheme() {
  const portal = usePublicBranding().data?.portal;
  useEffect(() => {
    if (!portal) return;
    const root = document.documentElement;
    root.style.setProperty('--hv-accent', portal.accentColor);
    root.style.setProperty(
      '--hv-font-sans',
      portal.fontFamily === 'system'
        ? 'system-ui, sans-serif'
        : portal.fontFamily === 'noto-sans'
          ? '"Noto Sans", "Noto Sans Devanagari", "Noto Sans Arabic", sans-serif'
          : '"DM Sans Variable", "Noto Sans Devanagari", "Noto Sans Arabic", sans-serif',
    );
    const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const icon = existing ?? document.createElement('link');
    const previous = icon.href;
    if (portal.faviconUrl) {
      icon.rel = 'icon';
      icon.href = portal.faviconUrl;
      if (!existing) document.head.append(icon);
    }
    return () => {
      root.style.removeProperty('--hv-accent');
      root.style.removeProperty('--hv-font-sans');
      if (portal.faviconUrl) {
        if (existing) icon.href = previous;
        else icon.remove();
      }
    };
  }, [portal]);
  return null;
}
