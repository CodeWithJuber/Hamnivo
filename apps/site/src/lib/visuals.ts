import { type Locale, type ProductVisual, productVisuals } from '@hamnivo/brand';
import manifest from '@hamnivo/brand/visuals/manifest.json';

export type VisualId = ProductVisual['id'];

// Importing through Vite gives each file a content hash, so hosts can cache them forever.
const files = import.meta.glob<string>('@brand-visuals/*.{avif,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const urlByName = new Map(
  Object.entries(files).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]),
);

function fileUrl(name: string): string {
  const url = urlByName.get(name);
  if (!url) throw new Error(`Brand visual ${name} is missing; rebuild @hamnivo/brand`);
  return url;
}

export interface VisualSources {
  avifSrcset: string;
  webpSrcset: string;
  /** For browsers without srcset support. */
  src: string;
  width: number;
  height: number;
  alt: string;
}

/** Responsive sources from @hamnivo/brand's build, with the alt text for the page language. */
export function visualSources(id: VisualId, locale: Locale): VisualSources {
  const entry = manifest[id];
  const visual = productVisuals.find((v) => v.id === id);
  if (!visual) throw new Error(`Unknown brand visual ${id}`);
  const srcset = (ext: 'avif' | 'webp') =>
    entry.widths.map((w) => `${fileUrl(`${id}-${w}.${ext}`)} ${w}w`).join(', ');
  const fallback = entry.widths.filter((w) => w <= 960).at(-1) ?? entry.widths[0];
  return {
    avifSrcset: srcset('avif'),
    webpSrcset: srcset('webp'),
    src: fileUrl(`${id}-${fallback}.webp`),
    width: entry.width,
    height: entry.height,
    alt: visual.alt[locale],
  };
}
