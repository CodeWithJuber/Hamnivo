import { describe, expect, it } from 'vitest';
import {
  bestOn,
  contrastRatio,
  formatRatio,
  isHexColor,
  meetsAA,
  parseHex,
  relativeLuminance,
  validateTheme,
} from '../src/contrast.js';
import { palette } from '../src/tokens.js';

describe('contrast', () => {
  it('parses 3- and 6-digit hex colours', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex('192A30')).toEqual({ r: 25, g: 42, b: 48 });
    expect(() => parseHex('#12345')).toThrow(TypeError);
    expect(isHexColor('#E45136')).toBe(true);
    expect(isHexColor('coral')).toBe(false);
  });

  it('matches the WCAG reference extremes', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBeCloseTo(1, 10);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  it('reproduces the token-pair ratios published in Design-System.md', () => {
    expect(contrastRatio(palette.ink, palette.white)).toBeCloseTo(14.84, 1);
    expect(contrastRatio(palette.ink, palette.ivory)).toBeCloseTo(13.39, 1);
    expect(contrastRatio(palette.coral, palette.white)).toBeCloseTo(3.8, 1);
    expect(contrastRatio(palette.rust, palette.white)).toBeCloseTo(7.09, 1);
  });

  it('keeps coral out of small text but allows it for UI components', () => {
    expect(meetsAA(palette.coral, palette.white, 'text')).toBe(false);
    expect(meetsAA(palette.coral, palette.white, 'ui')).toBe(true);
    expect(meetsAA(palette.white, palette.coralStrong, 'text')).toBe(true);
  });

  it('never rounds a failing ratio up to a passing one', () => {
    expect(formatRatio(4.4999)).toBe('4.49:1');
  });

  it('picks the more readable foreground', () => {
    expect(bestOn(palette.ink, [palette.ink, palette.white])).toBe(palette.white);
    expect(bestOn(palette.ivory, [palette.white, palette.ink])).toBe(palette.ink);
  });
});

describe('validateTheme (W03)', () => {
  const base = {
    accent: palette.ink,
    onAccent: palette.white,
    surface: palette.white,
    text: palette.ink,
  };

  it('accepts the default ink theme', () => {
    expect(validateTheme(base)).toEqual([]);
  });

  it('rejects white text on raw coral with a readable message', () => {
    const issues = validateTheme({ ...base, accent: palette.coral });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('onAccent');
    expect(issues[0]?.message).toMatch(/Button text contrast is 3\.\d\d:1; at least 4\.5:1/);
  });

  it('flags an accent that disappears into the surface', () => {
    const issues = validateTheme({ ...base, accent: '#F2F2F2', onAccent: palette.ink });
    expect(issues.map((i) => i.field)).toContain('accent');
  });

  it('rejects values that are not hex colours instead of guessing', () => {
    const issues = validateTheme({ ...base, accent: 'red; background:url(x)' });
    expect(issues[0]?.field).toBe('accent');
    expect(issues[0]?.message).toMatch(/hex colour/);
  });
});
