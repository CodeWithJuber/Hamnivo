/**
 * Where the chat frame sits on the page (W02), as inline styles, for the size of the screen.
 * Pure, so every size can be tested without a browser.
 */

export type Mode = 'bubble' | 'panel' | 'inline' | 'fullpage';

export interface Viewport {
  /** Layout viewport: decides whether the chat floats or takes the screen. */
  width: number;
  height: number;
  /** Visual viewport: what is visible above an on-screen keyboard, and where it starts. */
  visibleHeight: number;
  visibleTop: number;
}

/**
 * Below either of these a floating chat is too small to read and type in, so launcher modes take
 * the whole screen: phones, phones held sideways (844×390) and a laptop at 200 % zoom (640×360).
 */
export const FULL_SCREEN_MAX_WIDTH = 480;
export const FULL_SCREEN_MAX_HEIGHT = 520;

/** Bubble: 20 px from the edge, above the 56 px launcher with a 12 px gap. */
const EDGE = 20;
const LAUNCHER = 56;
const GAP = 12;
const BUBBLE_WIDTH = 400;
const BUBBLE_MAX_HEIGHT = 704;
/** What the floating chat grows to when the visitor asks for more room. */
const EXPANDED_WIDTH = 720;
const EXPANDED_MAX_HEIGHT = 920;

/** Where the website put the launcher, and whether the visitor made the chat larger. */
export interface Place {
  /** The launcher's distance from the side and from the bottom, in pixels (20 unless set). */
  x?: number;
  y?: number;
  /** The launcher's height in pixels (56 unless set). */
  launcher?: number;
  expanded?: boolean;
}

export function isFullScreen(mode: Mode, viewport: Viewport): boolean {
  if (mode === 'fullpage') return true;
  if (mode === 'inline') return false;
  return viewport.width <= FULL_SCREEN_MAX_WIDTH || viewport.height <= FULL_SCREEN_MAX_HEIGHT;
}

/** The frame's position and size; null for inline, which the page's own layout places. */
export function placement(
  mode: Mode,
  viewport: Viewport,
  side: 'left' | 'right',
  place: Place = {},
): Record<string, string> | null {
  if (mode === 'inline') return null;
  const left = side === 'left';
  if (isFullScreen(mode, viewport)) {
    // Sized to the visible area, so an open keyboard hides nothing of the message box.
    return {
      top: `${viewport.visibleTop}px`,
      left: '0',
      right: 'auto',
      bottom: 'auto',
      width: '100%',
      height: `${viewport.visibleHeight}px`,
      'border-radius': '0',
    };
  }
  if (mode === 'panel') {
    return {
      top: '0',
      bottom: 'auto',
      left: left ? '0' : 'auto',
      right: left ? 'auto' : '0',
      width: `${Math.min(place.expanded ? 640 : 420, viewport.width)}px`,
      height: `${viewport.visibleHeight}px`,
      'border-radius': '0',
    };
  }
  const x = place.x ?? EDGE;
  const above = (place.y ?? EDGE) + (place.launcher ?? LAUNCHER) + GAP;
  const width = place.expanded ? EXPANDED_WIDTH : BUBBLE_WIDTH;
  const height = place.expanded ? EXPANDED_MAX_HEIGHT : BUBBLE_MAX_HEIGHT;
  return {
    top: 'auto',
    bottom: `${above}px`,
    left: left ? `${x}px` : 'auto',
    right: left ? 'auto' : `${x}px`,
    // Never wider or taller than the window leaves room for, wherever the launcher sits.
    width: `${Math.max(0, Math.min(width, viewport.width - x - EDGE))}px`,
    height: `${Math.max(0, Math.min(height, viewport.visibleHeight - above - 16))}px`,
    'border-radius': '16px',
  };
}
