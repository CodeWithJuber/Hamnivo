import { describe, expect, it } from 'vitest';
import { hiddenOn } from '../src/pages.js';
import { schemeOf, tone } from '../src/theme.js';

describe('the page’s own theme', () => {
  it('reads how light a computed colour is, in the notations browsers report', () => {
    expect(tone('rgb(255, 255, 255)')?.light).toBeCloseTo(1);
    expect(tone('rgb(255, 255, 255)')?.alpha).toBe(1);
    expect(tone('rgb(0 0 0 / 50%)')).toEqual({ light: 0, alpha: 0.5 });
    expect(tone('rgba(0, 0, 0, 0)')).toEqual({ light: 0, alpha: 0 });
    expect(tone('rgb(15, 26, 30)')?.light).toBeLessThan(0.2);
    expect(tone('oklch(0.21 0.034 264.665)')?.light).toBeCloseTo(0.21);
    expect(tone('oklch(98% 0.01 90 / 0.4)')).toEqual({ light: 0.98, alpha: 0.4 });
    expect(tone('lab(20 5 -10)')?.light).toBeCloseTo(0.2);
    expect(tone('lch(95% 3 80)')?.light).toBeCloseTo(0.95);
    expect(tone('color(srgb 0.1 0.1 0.1)')?.light).toBeCloseTo(0.1);
    expect(tone('transparent')).toBeNull();
    expect(tone('')).toBeNull();
  });

  it('follows the background the page paints, the body’s before the root’s', () => {
    expect(schemeOf(['rgb(17, 24, 39)', 'rgb(255, 255, 255)'], 'normal', false)).toBe('dark');
    expect(schemeOf(['rgba(0, 0, 0, 0)', 'rgb(250, 250, 250)'], 'dark', true)).toBe('light');
    expect(schemeOf(['rgba(0, 0, 0, 0)', 'oklch(0.15 0.02 260)'], 'normal', false)).toBe('dark');
    // A nearly see-through tint is not what the visitor sees.
    expect(schemeOf(['rgba(0, 0, 0, 0.05)', 'rgba(0, 0, 0, 0)'], 'normal', false)).toBe('light');
  });

  it('falls back to the colour scheme the page declares, never to the device alone', () => {
    const clear = ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'];
    expect(schemeOf(clear, 'normal', true)).toBe('light');
    expect(schemeOf(clear, 'light', true)).toBe('light');
    expect(schemeOf(clear, 'dark', false)).toBe('dark');
    expect(schemeOf(clear, 'light dark', true)).toBe('dark');
    expect(schemeOf(clear, 'light dark', false)).toBe('light');
    expect(schemeOf([], 'only dark', false)).toBe('dark');
  });
});

describe('pages the website keeps the chat off', () => {
  it('matches exact paths and paths with a star', () => {
    expect(hiddenOn('/checkout', '/checkout')).toBe(true);
    expect(hiddenOn('/checkout', '/checkout/')).toBe(true);
    expect(hiddenOn('/checkout', '/checkout/pay')).toBe(false);
    expect(hiddenOn('/checkout*', '/checkout/pay')).toBe(true);
    expect(hiddenOn(' /admin/* , /cart ', '/admin/users/7')).toBe(true);
    expect(hiddenOn(' /admin/* , /cart ', '/cart')).toBe(true);
    expect(hiddenOn('*/print', '/orders/9/print')).toBe(true);
  });

  it('hides nothing without a rule, and reads a dot as a dot', () => {
    expect(hiddenOn(undefined, '/')).toBe(false);
    expect(hiddenOn('', '/')).toBe(false);
    expect(hiddenOn(' , ', '/')).toBe(false);
    expect(hiddenOn('/a.html', '/axhtml')).toBe(false);
    expect(hiddenOn('/a.html', '/a.html')).toBe(true);
  });
});
