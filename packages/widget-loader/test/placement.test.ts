import { describe, expect, it } from 'vitest';
import { isFullScreen, placement, type Viewport } from '../src/placement.js';

const screen = (width: number, height: number, keyboard = 0): Viewport => ({
  width,
  height,
  visibleHeight: height - keyboard,
  visibleTop: 0,
});

describe('where the chat sits for each screen (W02)', () => {
  it.each([
    ['a small phone', 320, 568],
    ['a Galaxy Fold, folded', 280, 653],
    ['a large phone', 430, 932],
    ['a phone held sideways', 844, 390],
    ['a small phone held sideways', 568, 320],
    ['a 1280×720 laptop at 200 % zoom', 640, 360],
  ])('takes the whole screen on %s (%i×%i)', (_name, width, height) => {
    for (const mode of ['bubble', 'panel'] as const) {
      expect(isFullScreen(mode, screen(width, height))).toBe(true);
      expect(placement(mode, screen(width, height), 'right')).toMatchObject({
        top: '0px',
        width: '100%',
        height: `${height}px`,
        'border-radius': '0',
      });
    }
  });

  it('keeps the message box above an open keyboard', () => {
    const style = placement('bubble', { ...screen(390, 844, 300), visibleTop: 40 }, 'right');
    expect(style).toMatchObject({ top: '40px', height: '544px' });
  });

  it('floats above the launcher on tablets and desktops, up to 704 px tall', () => {
    expect(placement('bubble', screen(1440, 900), 'right')).toMatchObject({
      bottom: '88px',
      right: '20px',
      left: 'auto',
      width: '400px',
      height: '704px',
    });
    expect(placement('bubble', screen(768, 1024), 'left')).toMatchObject({
      left: '20px',
      right: 'auto',
    });
  });

  it('fits a short desktop window without leaving the screen', () => {
    const style = placement('bubble', screen(1280, 600), 'right');
    expect(style?.height).toBe('496px');
    // 88 px from the bottom plus its height stays inside the window.
    expect(88 + Number.parseInt(style?.height ?? '0', 10)).toBeLessThanOrEqual(600);
  });

  it('never floats wider than the screen allows', () => {
    expect(placement('bubble', screen(500, 800), 'right')?.width).toBe('400px');
    expect(placement('bubble', screen(481, 800), 'right')?.width).toBe('400px');
  });

  it('opens the side panel at full height, 420 px wide', () => {
    expect(placement('panel', screen(1024, 768), 'left')).toMatchObject({
      top: '0',
      left: '0',
      right: 'auto',
      width: '420px',
      height: '768px',
    });
  });

  it('leaves inline to the page and always fills the screen in full-page mode', () => {
    expect(placement('inline', screen(320, 568), 'right')).toBeNull();
    expect(isFullScreen('inline', screen(320, 568))).toBe(false);
    expect(isFullScreen('fullpage', screen(1920, 1080))).toBe(true);
  });
});
