/**
 * Traces the supplied raster brand assets into SVG.
 *
 *   source/hamnivo-icon.png  (1254² RGBA, transparent)  → assets/hamnivo-mark*.svg
 *   source/hamnivo-logo.png  (1774×887 RGB, ivory bg)   → assets/hamnivo-lockup*.svg, hamnivo-wordmark.svg
 *
 * Method: upscale 4× (lanczos3) → label pixels by nearest brand colour → trace each colour layer
 * with potrace → compose → SVGO. Quality gate: the SVG is rendered back and compared with the
 * source labels; intersection-over-union must be ≥ 0.97 for every colour layer.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { optimize } from 'svgo';
import { palette } from '../src/tokens.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = 4;
export const MIN_IOU = 0.97;

interface Raster {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

async function load(path: string, scale: number): Promise<Raster> {
  const image = sharp(path).ensureAlpha();
  const meta = await image.metadata();
  const width = (meta.width ?? 0) * scale;
  const height = (meta.height ?? 0) * scale;
  const { data } = await image
    .resize(width, height, { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width, height, channels: 4 };
}

/** Pixel classes: 0 = empty/background, 1 = ink, 2 = coral. */
export const INK = 1;
export const CORAL = 2;

export interface Classifier {
  /** Minimum red dominance (r − mean(g, b)) for coral. Anti-aliased greys stay near 0. */
  coralRedness: number;
  /**
   * For opaque sources: luminance below which a non-coral pixel is ink (midpoint between the ink
   * and background luminance). Undefined for transparent sources, where any opaque pixel counts.
   */
  inkLuminanceBelow?: number;
}

/**
 * Labels pixels by hue and luminance rather than nearest RGB colour: an anti-aliased grey between
 * ink and ivory is closer to coral in RGB space than to either endpoint, so nearest-colour
 * classification sprinkles false coral along every letter edge.
 */
export function label(raster: Raster, classifier: Classifier): Uint8Array {
  const out = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    if ((raster.data[o + 3] ?? 0) < 128) continue;
    const r = raster.data[o] ?? 0;
    const g = raster.data[o + 1] ?? 0;
    const b = raster.data[o + 2] ?? 0;
    if (r - (g + b) / 2 >= classifier.coralRedness) {
      out[i] = CORAL;
      continue;
    }
    if (classifier.inkLuminanceBelow === undefined) {
      out[i] = INK;
      continue;
    }
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance < classifier.inkLuminanceBelow) out[i] = INK;
  }
  return out;
}

function toPbm(mask: Uint8Array, width: number, height: number, value: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const header = Buffer.from(`P4\n${width} ${height}\n`, 'ascii');
  const body = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === value) {
        const byte = y * rowBytes + (x >> 3);
        body[byte] = (body[byte] ?? 0) | (0x80 >> (x & 7));
      }
    }
  }
  return Buffer.concat([header, body]);
}

/** Returns the potrace <g> (with its transform) containing the traced paths. */
function trace(mask: Uint8Array, width: number, height: number, value: number): string {
  const svg = execFileSync(
    'potrace',
    ['--svg', '--turdsize', '10', '--alphamax', '1', '--opttolerance', '0.2', '-o', '-', '-'],
    { input: toPbm(mask, width, height, value), maxBuffer: 64 * 1024 * 1024 },
  ).toString('utf8');
  const group = /<g transform="([^"]+)"[^>]*>([\s\S]*?)<\/g>/.exec(svg);
  if (!group) throw new Error('potrace produced no paths');
  return `<g transform="${group[1]}">${group[2]}</g>`;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function bbox(mask: Uint8Array, width: number, height: number, keep: (x: number) => boolean): Box {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] && keep(x)) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** Column index splitting the mark from the wordmark (widest empty column gap). */
function splitColumn(mask: Uint8Array, width: number, height: number): number {
  const used = new Array<boolean>(width).fill(false);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x]) {
        used[x] = true;
        break;
      }
    }
  }
  let bestStart = 0;
  let bestLength = 0;
  let runStart = -1;
  const first = used.indexOf(true);
  const last = used.lastIndexOf(true);
  for (let x = first; x <= last; x++) {
    if (!used[x]) {
      if (runStart < 0) runStart = x;
    } else if (runStart >= 0) {
      if (x - runStart > bestLength) {
        bestLength = x - runStart;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }
  return bestStart + Math.floor(bestLength / 2);
}

interface LayerSpec {
  value: number;
  fill: string;
}

function compose(
  groups: { g: string; fill: string }[],
  box: Box,
  pad: number,
  title: string,
): string {
  const x = box.x0 - pad;
  const y = box.y0 - pad;
  const w = box.x1 - box.x0 + pad * 2;
  const h = box.y1 - box.y0 + pad * 2;
  const body = groups.map(({ g, fill }) => g.replace('<g ', `<g fill="${fill}" `)).join('');
  const raw = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" role="img"><title>${title}</title>${body}</svg>`;
  return optimize(raw, {
    multipass: true,
    floatPrecision: 1,
    plugins: ['preset-default', 'removeDimensions'],
  }).data;
}

async function renderLabels(svg: string, width: number, height: number, classifier: Classifier) {
  const { data } = await sharp(Buffer.from(svg), { density: 72 })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return label({ data, width, height, channels: 4 }, classifier);
}

export function iou(a: Uint8Array, b: Uint8Array, value: number): number {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] === value;
    const inB = b[i] === value;
    if (inA && inB) inter++;
    if (inA || inB) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/** Recolours a composed SVG (used for dark and mono variants). */
function recolor(svg: string, map: Record<string, string>): string {
  let out = svg;
  // SVGO lower-cases colours, so match hex values case-insensitively.
  for (const [from, to] of Object.entries(map)) out = out.replace(new RegExp(from, 'gi'), to);
  return out;
}

/** Emits the mark's geometry as a TS module so UI code can render it inline without raw SVG imports. */
function writeMarkModule(svg: string) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  const paths = [...svg.matchAll(/<path fill="([^"]+)" d="([^"]+)"/g)].map((m) => ({
    fill: m[1] ?? '',
    d: m[2] ?? '',
  }));
  const ink = paths.find((p) => p.fill.toLowerCase() === palette.ink.toLowerCase());
  const coral = paths.find((p) => p.fill.toLowerCase() === palette.coral.toLowerCase());
  if (!viewBox || !ink || !coral) throw new Error('Unexpected mark SVG structure');
  const dir = join(pkg, 'src', 'generated');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'mark.ts'),
    `/* Generated by scripts/vectorize.ts. Do not edit. */\nexport const markGeometry = {\n  viewBox: ${JSON.stringify(viewBox)},\n  ink: ${JSON.stringify(ink.d)},\n  coral: ${JSON.stringify(coral.d)},\n} as const;\n`,
  );
}

async function run() {
  const assets = join(pkg, 'assets');
  mkdirSync(assets, { recursive: true });
  const report: Record<string, number> = {};

  // Mark (standalone icon).
  const transparent: Classifier = { coralRedness: 60 };
  const icon = await load(join(pkg, 'source/hamnivo-icon.png'), SCALE);
  const iconLabels = label(icon, transparent);
  const layers: LayerSpec[] = [
    { value: INK, fill: palette.ink },
    { value: CORAL, fill: palette.coral },
  ];
  const markGroups = layers.map((l) => ({
    g: trace(iconLabels, icon.width, icon.height, l.value),
    fill: l.fill,
  }));
  const markBox = bbox(iconLabels, icon.width, icon.height, () => true);
  const markPad = Math.round((markBox.y1 - markBox.y0) * 0.04);
  const mark = compose(markGroups, markBox, markPad, 'Hamnivo');

  // IoU gate at 1× against the unscaled source.
  const icon1x = await load(join(pkg, 'source/hamnivo-icon.png'), 1);
  const src1x = label(icon1x, transparent);
  const markFull = compose(
    markGroups,
    { x0: 0, y0: 0, x1: icon.width, y1: icon.height },
    0,
    'Hamnivo',
  );
  const rendered = await renderLabels(markFull, icon1x.width, icon1x.height, transparent);
  report['mark.ink'] = iou(src1x, rendered, INK);
  report['mark.coral'] = iou(src1x, rendered, CORAL);

  writeFileSync(join(assets, 'hamnivo-mark.svg'), mark);
  writeMarkModule(mark);
  writeFileSync(
    join(assets, 'hamnivo-mark-on-dark.svg'),
    recolor(mark, { [palette.ink]: palette.ivory }),
  );
  writeFileSync(
    join(assets, 'hamnivo-mark-mono.svg'),
    recolor(mark, { [palette.ink]: 'currentColor', [palette.coral]: 'currentColor' }),
  );

  // Lockup and wordmark.
  // Ink ≈ luminance 42, ivory background ≈ 243 → midpoint 142.
  const onIvory: Classifier = { coralRedness: 60, inkLuminanceBelow: 142 };
  const logo = await load(join(pkg, 'source/hamnivo-logo.png'), SCALE);
  const logoLabels = label(logo, onIvory);
  const lockGroups = layers.map((l) => ({
    g: trace(logoLabels, logo.width, logo.height, l.value),
    fill: l.fill,
  }));
  const lockBox = bbox(logoLabels, logo.width, logo.height, () => true);
  const lockPad = Math.round((lockBox.y1 - lockBox.y0) * 0.06);
  const lockup = compose(lockGroups, lockBox, lockPad, 'Hamnivo');

  const logo1x = await load(join(pkg, 'source/hamnivo-logo.png'), 1);
  const logoSrc1x = label(logo1x, onIvory);
  const lockFull = compose(
    lockGroups,
    { x0: 0, y0: 0, x1: logo.width, y1: logo.height },
    0,
    'Hamnivo',
  );
  // The rendered SVG has a transparent background, so any opaque non-coral pixel is ink.
  const lockRendered = await renderLabels(lockFull, logo1x.width, logo1x.height, transparent);
  report['lockup.ink'] = iou(logoSrc1x, lockRendered, INK);
  report['lockup.coral'] = iou(logoSrc1x, lockRendered, CORAL);

  const split = splitColumn(logoLabels, logo.width, logo.height);
  const wordLabels = logoLabels.map((v, i) => (i % logo.width >= split ? v : 0));
  const wordGroup = [{ g: trace(wordLabels, logo.width, logo.height, INK), fill: palette.ink }];
  const wordBox = bbox(wordLabels, logo.width, logo.height, () => true);
  const wordmark = compose(
    wordGroup,
    wordBox,
    Math.round((wordBox.y1 - wordBox.y0) * 0.06),
    'Hamnivo',
  );

  writeFileSync(join(assets, 'hamnivo-lockup.svg'), lockup);
  writeFileSync(
    join(assets, 'hamnivo-lockup-on-dark.svg'),
    recolor(lockup, { [palette.ink]: palette.ivory }),
  );
  writeFileSync(join(assets, 'hamnivo-wordmark.svg'), wordmark);
  writeFileSync(join(assets, 'vectorize-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const failing = Object.entries(report).filter(([, v]) => v < MIN_IOU);
  for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(14)} IoU ${v.toFixed(4)}`);
  if (failing.length) {
    console.error(`Tracing below IoU ${MIN_IOU}: ${failing.map(([k]) => k).join(', ')}`);
    process.exit(1);
  }
}

await run();
