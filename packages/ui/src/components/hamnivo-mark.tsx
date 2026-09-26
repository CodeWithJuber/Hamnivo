import { markGeometry } from '@hamnivo/brand';
import type * as React from 'react';
import { cn } from '../lib/utils';

type HamnivoMarkProps = Omit<React.ComponentProps<'svg'>, 'viewBox'> & {
  /** `brand` = ink + coral, `inverse` = ivory + coral (dark surfaces), `mono` = currentColor. */
  tone?: 'brand' | 'inverse' | 'mono';
  /** Accessible name. Omit only when the mark is decorative next to visible text. */
  title?: string;
};

/** The approved Hamnivo "H" signature mark, rendered from the traced vector geometry. */
function HamnivoMark({ tone = 'brand', title, className, ...props }: HamnivoMarkProps) {
  const ink =
    tone === 'brand' ? 'var(--hv-text, #192A30)' : tone === 'inverse' ? '#F6F3EC' : 'currentColor';
  const coral = tone === 'mono' ? 'currentColor' : '#E45136';
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: a title is rendered when `title` is given; otherwise the mark is aria-hidden decoration.
    <svg
      viewBox={markGeometry.viewBox}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      className={cn('size-6 shrink-0', className)}
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path fill={ink} d={markGeometry.ink} />
      <path fill={coral} d={markGeometry.coral} />
    </svg>
  );
}

export { HamnivoMark, type HamnivoMarkProps };
