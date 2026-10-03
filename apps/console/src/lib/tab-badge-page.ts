/**
 * The part of the tab badge that touches the page: the tab's icon (the Hamnivo mark with a red dot
 * and the count) and the title. See tab-badge.ts for the text rules.
 */
import { markGeometry } from '@hamnivo/brand';
import { useEffect } from 'react';
import { badgeText, reconcileTitle, titleWithCount } from './tab-badge';

const LINK_ATTRIBUTE = 'data-hamnivo-tab-icon';
const SIZE = 64;

/** The tab icon as a PNG data address: the Hamnivo mark, with a red dot and the count if any. */
export function iconFor(count: number): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#F6F3EC';
    context.beginPath();
    context.roundRect(2, 2, SIZE - 4, SIZE - 4, 14);
    context.fill();
    const [, , width, height] = markGeometry.viewBox.split(/\s+/).map(Number);
    if (width && height) {
      const scale = (SIZE * 0.66) / Math.max(width, height);
      context.save();
      context.translate((SIZE - width * scale) / 2, (SIZE - height * scale) / 2);
      context.scale(scale, scale);
      context.fillStyle = '#192A30';
      context.fill(new Path2D(markGeometry.ink));
      context.fillStyle = '#E45136';
      context.fill(new Path2D(markGeometry.coral));
      context.restore();
    }
    const text = badgeText(count);
    if (text) {
      context.beginPath();
      context.arc(44, 20, 20, 0, Math.PI * 2);
      context.fillStyle = '#FFFFFF';
      context.fill();
      context.beginPath();
      context.arc(44, 20, 17, 0, Math.PI * 2);
      context.fillStyle = '#D92D20';
      context.fill();
      context.fillStyle = '#FFFFFF';
      context.font = `bold ${text.length > 1 ? 20 : 24}px system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(text, 44, 21);
    }
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function setIcon(href: string | null) {
  const existing = document.head.querySelector<HTMLLinkElement>(`link[${LINK_ATTRIBUTE}]`);
  if (!href) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.setAttribute(LINK_ATTRIBUTE, '');
  link.href = href;
  if (!existing) document.head.append(link);
}

/**
 * Keeps the tab title and icon in step with the count. Pages set their own title as they open,
 * so the count is put back in front whenever the title changes.
 */
export function useTabBadge(count: number): void {
  useEffect(() => {
    const apply = () => {
      const next = reconcileTitle(document.title, count);
      if (next !== null) document.title = next;
    };
    apply();
    const title = document.head.querySelector('title');
    const observer = title ? new MutationObserver(apply) : null;
    if (title) observer?.observe(title, { childList: true, characterData: true, subtree: true });
    setIcon(iconFor(count));
    return () => {
      observer?.disconnect();
      document.title = titleWithCount(document.title, 0);
      setIcon(null);
    };
  }, [count]);
}
