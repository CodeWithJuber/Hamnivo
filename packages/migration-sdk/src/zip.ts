import { unzipSync, zipSync } from 'fflate';

export type PackageErrorCode =
  | 'empty'
  | 'not_supported'
  | 'truncated'
  | 'corrupt'
  | 'too_large'
  | 'too_many_files'
  | 'unsafe_path'
  | 'not_utf8';

/** The upload itself cannot be read (as opposed to single records inside it). */
export class PackageError extends Error {
  override name = 'PackageError';
  constructor(
    readonly code: PackageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Largest uncompressed/compressed ratio per entry (zip bombs). */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxRatio: 300,
};

const LOCAL_HEADER = 0x04034b50;
const END_OF_DIRECTORY = 0x06054b50;

const u32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at] ?? 0) |
    ((bytes[at + 1] ?? 0) << 8) |
    ((bytes[at + 2] ?? 0) << 16) |
    ((bytes[at + 3] ?? 0) << 24)) >>>
  0;

export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 && (u32(bytes, 0) === LOCAL_HEADER || u32(bytes, 0) === END_OF_DIRECTORY)
  );
}

/** A complete archive ends with an end-of-directory record; a cut-off download does not. */
function hasEndOfDirectory(bytes: Uint8Array): boolean {
  const floor = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (u32(bytes, at) === END_OF_DIRECTORY) return true;
  }
  return false;
}

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 512 &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.split('/').some((part) => part === '..')
  );
}

/**
 * Unpacks a ZIP within limits. Sizes are checked from the directory before anything is inflated,
 * and inflated output is bounded by the declared size, so a zip bomb cannot exhaust memory.
 */
export function readZip(
  bytes: Uint8Array,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  if (!isZip(bytes)) throw new PackageError('not_supported', 'The file is not a ZIP archive.');
  if (bytes.length < 22 || !hasEndOfDirectory(bytes)) {
    throw new PackageError(
      'truncated',
      'The archive ends early. It may not have finished downloading.',
    );
  }
  let violation: PackageError | null = null;
  let entries = 0;
  let total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (violation || file.name.endsWith('/')) return false;
        entries += 1;
        total += file.originalSize;
        if (!safeName(file.name)) {
          violation = new PackageError('unsafe_path', 'The archive contains an unsafe file name.');
        } else if (entries > limits.maxEntries) {
          violation = new PackageError('too_many_files', 'The archive contains too many files.');
        } else if (
          file.originalSize > limits.maxEntryBytes ||
          total > limits.maxTotalBytes ||
          (file.size > 0 && file.originalSize / file.size > limits.maxRatio)
        ) {
          violation = new PackageError('too_large', 'The archive expands to more than we accept.');
        }
        return violation === null;
      },
    });
  } catch (error) {
    if (error instanceof PackageError) throw error;
    throw new PackageError('corrupt', 'The archive is damaged and cannot be read.');
  }
  if (violation) throw violation;
  return new Map(Object.entries(files).filter(([name]) => !name.endsWith('/')));
}

export function writeZip(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files), { level: 6 });
}

/**
 * The files of an uploaded export: a ZIP is unpacked; a single JSON or NDJSON file becomes a
 * one-file map under its own name.
 */
export function openExport(
  bytes: Uint8Array,
  fileName: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Map<string, Uint8Array> {
  if (bytes.length === 0) throw new PackageError('empty', 'The file is empty.');
  if (isZip(bytes)) return readZip(bytes, limits);
  if (bytes.length > limits.maxEntryBytes) {
    throw new PackageError('too_large', 'The file is larger than we accept.');
  }
  const first = bytes.find(
    (b) =>
      b !== 0x20 &&
      b !== 0x0a &&
      b !== 0x0d &&
      b !== 0x09 &&
      b !== 0xef &&
      b !== 0xbb &&
      b !== 0xbf,
  );
  if (first !== 0x7b && first !== 0x5b) {
    throw new PackageError('not_supported', 'The file is not a ZIP, JSON or NDJSON export.');
  }
  const name = fileName.split(/[\\/]/).pop()?.slice(0, 200) || 'export.json';
  return new Map([[name, bytes]]);
}

/** Strict UTF-8 text (a byte-order mark is dropped). */
export function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new PackageError('not_utf8', 'The file is not valid UTF-8 text.');
  }
}
