import { createReadStream, realpathSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

const require = createRequire(import.meta.url);

function brandPath(subpath: string): string {
  try {
    return dirname(realpathSync(require.resolve(`@hamnivo/brand/${subpath}`)));
  } catch (cause) {
    throw new Error(
      `@hamnivo/brand/${subpath} is missing. Run "pnpm --filter @hamnivo/brand build" first.`,
      { cause },
    );
  }
}

/** Brand package folders, resolved through its exports map. */
export const brandAssetsDir = brandPath('assets/favicon.svg');
export const brandVisualsDir = brandPath('visuals/manifest.json');

/**
 * Files that must keep fixed names at the site root: browsers ask for /favicon.ico directly,
 * the web manifest points at its icons by relative name, and link previews fetch og-image.png.
 */
const ROOT_FILES = [
  'favicon.ico',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
  'site.webmanifest',
  'og-image.png',
];

const TYPES: Record<string, string> = {
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Serves the root brand files in development and copies them into the build output. */
export function brandRootFiles(): AstroIntegration {
  return {
    name: 'hamnivo:brand-root-files',
    hooks: {
      'astro:server:setup': ({ server }) => {
        server.middlewares.use((req, res, next) => {
          const name = req.url?.split('?')[0]?.slice(1) ?? '';
          if (!ROOT_FILES.includes(name)) return next();
          res.setHeader('Content-Type', TYPES[extname(name)] ?? 'application/octet-stream');
          createReadStream(join(brandAssetsDir, name)).pipe(res);
        });
      },
      'astro:build:done': async ({ dir }) => {
        const out = fileURLToPath(dir);
        await Promise.all(
          ROOT_FILES.map((name) => copyFile(join(brandAssetsDir, name), join(out, name))),
        );
      },
    },
  };
}
