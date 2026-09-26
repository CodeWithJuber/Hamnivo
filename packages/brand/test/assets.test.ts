import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { brandAssets, productVisuals } from '../src/assets.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('product visuals', () => {
  it('covers the six supplied illustrations exactly once', () => {
    expect(productVisuals.map((v) => v.id).sort()).toEqual(
      ['commerce', 'hero', 'integrations', 'memory', 'multilingual', 'teamwork'].sort(),
    );
  });

  for (const visual of productVisuals) {
    it(`${visual.id}: source matches declared size and has alt text in every locale`, async () => {
      const meta = await sharp(join(pkg, 'source', visual.source)).metadata();
      expect([meta.width, meta.height]).toEqual([visual.width, visual.height]);
      for (const locale of ['en', 'ar', 'hi', 'ur'] as const) {
        expect(visual.alt[locale].length).toBeGreaterThan(20);
        expect(visual.caption[locale].length).toBeGreaterThan(3);
      }
    });
  }
});

describe('generated brand assets', () => {
  it('exist for every manifest entry', () => {
    for (const file of Object.values(brandAssets)) {
      expect(existsSync(join(pkg, 'assets', file)), file).toBe(true);
    }
  });

  it('were traced with IoU ≥ 0.97 on every colour layer', () => {
    const report = JSON.parse(readFileSync(join(pkg, 'assets/vectorize-report.json'), 'utf8'));
    for (const [layer, value] of Object.entries(report)) {
      expect(value as number, layer).toBeGreaterThanOrEqual(0.97);
    }
  });

  it('keeps the favicon theme-aware and the on-dark mark free of ink', () => {
    const favicon = readFileSync(join(pkg, 'assets/favicon.svg'), 'utf8');
    expect(favicon).toContain('prefers-color-scheme:dark');
    const onDark = readFileSync(join(pkg, 'assets/hamnivo-mark-on-dark.svg'), 'utf8');
    expect(onDark.toLowerCase()).not.toContain('#192a30');
  });

  it('packs a valid ICO header with three PNG entries', () => {
    const icoFile = readFileSync(join(pkg, 'assets/favicon.ico'));
    expect(icoFile.readUInt16LE(2)).toBe(1);
    expect(icoFile.readUInt16LE(4)).toBe(3);
    const firstOffset = icoFile.readUInt32LE(6 + 12);
    expect(icoFile.subarray(firstOffset, firstOffset + 4).toString('latin1')).toBe('\x89PNG');
  });
});
