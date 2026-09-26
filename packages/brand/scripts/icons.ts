/**
 * Generates favicons, app icons, the Open Graph image and the web manifest from the traced SVGs
 * (run scripts/vectorize.ts first). Outputs go to assets/.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { palette } from '../src/tokens.js';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const read = (file: string) => readFileSync(join(assets, file), 'utf8');

/** Renders an SVG centred on a square canvas with the given padding ratio. */
async function square(svg: string, size: number, padding: number, background?: string) {
  const inner = Math.round(size * (1 - padding * 2));
  const glyph = await sharp(Buffer.from(svg), { density: 72 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const canvas = sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });
  return canvas
    .composite([{ input: glyph, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Packs PNG images into a Windows ICO container (PNG-compressed entries). */
export function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function run() {
  const mark = read('hamnivo-mark.svg');
  const markOnDark = read('hamnivo-mark-on-dark.svg');
  const lockup = read('hamnivo-lockup.svg');

  // SVG favicon that follows the browser colour scheme.
  const inkFill = new RegExp(`fill="${palette.ink}"`, 'i');
  if (!inkFill.test(mark)) throw new Error('mark SVG has no ink fill to theme');
  const favicon = mark
    .replace(inkFill, 'class="ink"')
    .replace(
      /<title>/,
      `<style>.ink{fill:${palette.ink}}@media (prefers-color-scheme:dark){.ink{fill:${palette.ivory}}}</style><title>`,
    );
  writeFileSync(join(assets, 'favicon.svg'), favicon);

  const icoSizes = [16, 32, 48];
  const icoImages = await Promise.all(
    icoSizes.map(async (size) => ({ size, png: await square(mark, size, 0.02) })),
  );
  writeFileSync(join(assets, 'favicon.ico'), ico(icoImages));

  writeFileSync(join(assets, 'apple-touch-icon.png'), await square(mark, 180, 0.14, palette.ivory));
  writeFileSync(join(assets, 'icon-192.png'), await square(mark, 192, 0.06));
  writeFileSync(join(assets, 'icon-512.png'), await square(mark, 512, 0.06));
  // Maskable icons keep the glyph inside the 80% safe zone.
  writeFileSync(
    join(assets, 'icon-maskable-512.png'),
    await square(mark, 512, 0.22, palette.ivory),
  );
  writeFileSync(
    join(assets, 'icon-maskable-dark-512.png'),
    await square(markOnDark, 512, 0.22, palette.ink),
  );

  // Open Graph image: lockup centred on ivory, 1200×630.
  const lockupPng = await sharp(Buffer.from(lockup), { density: 72 })
    .resize(760, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const og = await sharp({
    create: { width: 1200, height: 630, channels: 4, background: palette.ivory },
  })
    .composite([{ input: lockupPng, gravity: 'centre' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(assets, 'og-image.png'), og);

  const manifest = {
    name: 'Hamnivo',
    short_name: 'Hamnivo',
    description: 'Conversations, people and agents in one place.',
    start_url: '/',
    display: 'standalone',
    background_color: palette.ivory,
    theme_color: palette.ink,
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  writeFileSync(join(assets, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

await run();
