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
const ABOVE_LAUNCHER = 88;
const BUBBLE_WIDTH = 400;
const BUBBLE_MAX_HEIGHT = 704;

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
      width: `${Math.min(420, viewport.width)}px`,
      height: `${viewport.visibleHeight}px`,
      'border-radius': '0',
    };
  }
  return {
    top: 'auto',
    bottom: `${ABOVE_LAUNCHER}px`,
    left: left ? `${EDGE}px` : 'auto',
    right: left ? 'auto' : `${EDGE}px`,
    width: `${Math.min(BUBBLE_WIDTH, viewport.width - 2 * EDGE)}px`,
    height: `${Math.min(BUBBLE_MAX_HEIGHT, viewport.visibleHeight - ABOVE_LAUNCHER - 16)}px`,
    'border-radius': '16px',
  };
}
