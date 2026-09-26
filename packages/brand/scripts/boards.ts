/**
 * Converts the design-kit board originals (docs/design/.originals/*.png, git-ignored) into
 * review-sized WebP copies committed under docs/design/boards/.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = join(root, 'docs/design/.originals');
const dest = join(root, 'docs/design/boards');
mkdirSync(dest, { recursive: true });
for (const file of readdirSync(src)
  .filter((f) => f.endsWith('.png'))
  .sort()) {
  await sharp(join(src, file))
    .resize({ width: 1440, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(join(dest, file.replace(/\.png$/, '.webp')));
}
