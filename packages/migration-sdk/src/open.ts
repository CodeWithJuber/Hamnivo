import { tawkAdapter } from './adapters/tawk.js';
import { MANIFEST_FILE } from './model.js';
import { packageAdapter } from './package/reader.js';
import type { FileSourceAdapter, ParsedSource, SourceSystem } from './types.js';
import { DEFAULT_ZIP_LIMITS, openExport, type ZipLimits } from './zip.js';

/** Adapters for uploaded exports, by source system. */
export const FILE_ADAPTERS: Partial<Record<SourceSystem, FileSourceAdapter>> = {
  'tawk.to': tawkAdapter,
  hamnivo: packageAdapter,
};

/** Which system an unpacked export most likely comes from (null when it cannot tell). */
export function detectSystem(files: Map<string, Uint8Array>): SourceSystem | null {
  if (files.has(MANIFEST_FILE)) return 'hamnivo';
  const names = [...files.keys()].filter((n) => !/(^|\/)(__MACOSX\/|\.DS_Store$)/.test(n));
  if (names.length === 1 && /\.(ndjson|jsonl)$/i.test(names[0] ?? '')) return 'hamnivo';
  if (names.some((n) => /\.json$/i.test(n))) return 'tawk.to';
  return null;
}

export interface OpenedSource {
  system: SourceSystem;
  /** The system the file looks like it comes from, when it differs from the one chosen. */
  detected: SourceSystem | null;
  parsed: ParsedSource;
  adapter: FileSourceAdapter;
}

/** Unpacks and reads an uploaded export with the adapter of the chosen source system. */
export function readExport(
  bytes: Uint8Array,
  fileName: string,
  system: SourceSystem,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): OpenedSource {
  const adapter = FILE_ADAPTERS[system];
  if (!adapter) throw new RangeError(`No file adapter for ${system}`);
  const files = openExport(bytes, fileName, limits);
  const detected = detectSystem(files);
  return {
    system,
    detected: detected === system ? null : detected,
    parsed: adapter.parse(files),
    adapter,
  };
}
