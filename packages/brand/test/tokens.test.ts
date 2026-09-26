import { describe, expect, it } from 'vitest';
import { AA_THRESHOLD, contrastRatio } from '../src/contrast.js';
import { colors, contrastPairs, spacing, type ThemeName } from '../src/tokens.js';

describe('semantic colour tokens', () => {
  it('defines the same roles for light and dark themes', () => {
    expect(Object.keys(colors.dark).sort()).toEqual(Object.keys(colors.light).sort());
  });

  for (const theme of ['light', 'dark'] as ThemeName[]) {
    describe(theme, () => {
      for (const pair of contrastPairs) {
        const fg = colors[theme][pair.fg];
        const bg = colors[theme][pair.bg];
        it(`${pair.fg} on ${pair.bg} meets ${pair.use} contrast`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(AA_THRESHOLD[pair.use]);
        });
      }
    });
  }

  it('uses the kit spacing scale', () => {
    expect(spacing).toEqual([4, 8, 12, 16, 24, 32]);
  });
});
