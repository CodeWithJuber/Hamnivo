/**
 * Build step: responsive AVIF + WebP variants of the product visuals into dist/visuals/,
 * named <id>-<width>.<ext>, plus dist/visuals/manifest.json for consumers (console, site).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { productVisuals } from '../src/assets.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(pkg, 'dist', 'visuals');
mkdirSync(out, { recursive: true });

export const VISUAL_WIDTHS = [320, 640, 960, 1254, 1536] as const;

const manifest: Record<string, { widths: number[]; width: number; height: number }> = {};
for (const visual of productVisuals) {
  const widths = VISUAL_WIDTHS.filter((w) => w <= visual.width);
  for (const width of widths) {
    const base = sharp(join(pkg, 'source', visual.source)).resize({ width });
    await base
      .clone()
      .webp({ quality: 82, alphaQuality: 90 })
      .toFile(join(out, `${visual.id}-${width}.webp`));
    await base
      .clone()
      .avif({ quality: 60 })
      .toFile(join(out, `${visual.id}-${width}.avif`));
  }
  manifest[visual.id] = { widths: [...widths], width: visual.width, height: visual.height };
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
