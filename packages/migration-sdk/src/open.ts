import { isClutter, isJsonFile } from './adapters/common.js';
import { intercomAdapter } from './adapters/intercom.js';
import { tawkAdapter } from './adapters/tawk.js';
import { zendeskAdapter } from './adapters/zendesk.js';
import { MANIFEST_FILE } from './model.js';
import { packageAdapter } from './package/reader.js';
import type { FileSourceAdapter, ParsedSource, SourceSystem } from './types.js';
import { DEFAULT_ZIP_LIMITS, openExport, type ZipLimits } from './zip.js';

/** Adapters for uploaded exports, by source system. */
export const FILE_ADAPTERS: Partial<Record<SourceSystem, FileSourceAdapter>> = {
  'tawk.to': tawkAdapter,
  hamnivo: packageAdapter,
  zendesk: zendeskAdapter,
  intercom: intercomAdapter,
};

/** How much of each file is looked at to tell where it comes from. */
const SNIFF_BYTES = 8192;
const SNIFF_FILES = 20;

/** The system a JSON file's first bytes point to, by field names only its exports use. */
function sniff(bytes: Uint8Array): SourceSystem | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SNIFF_BYTES));
  if (/"format"\s*:\s*"hamnivo\.migration"/.test(head)) return 'hamnivo';
  if (/"source"\s*:\s*\{[^{}]*"system"\s*:/.test(head)) return 'hamnivo';
  if (
    /^\s*\{\s*"(ticket|user|organization)"\s*:\s*\{/.test(head) ||
    /"requester_id"\s*:/.test(head) ||
    /\.zendesk\.com\/api\/v2\//.test(head)
  ) {
    return 'zendesk';
  }
  if (/"conversation_parts"\s*:/.test(head) || /"type"\s*:\s*"conversation(\.list)?"/.test(head)) {
    return 'intercom';
  }
  if (
    /"visitor"\s*:/.test(head) ||
    /"type"\s*:\s*"chat"/.test(head) ||
    /"messages"\s*:\s*\[/.test(head)
  ) {
    return 'tawk.to';
  }
  return null;
}

/** Which system an unpacked export most likely comes from (null when it cannot tell). */
export function detectSystem(files: Map<string, Uint8Array>): SourceSystem | null {
  if (files.has(MANIFEST_FILE)) return 'hamnivo';
  const names = [...files.keys()].filter((n) => !isClutter(n)).sort();
  const votes = new Map<SourceSystem, number>();
  for (const name of names.filter(isJsonFile).slice(0, SNIFF_FILES)) {
    const system = sniff(files.get(name) as Uint8Array);
    if (system) votes.set(system, (votes.get(system) ?? 0) + 1);
  }
  const [best] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  if (best) return best[0];
  if (names.length === 1 && /\.(ndjson|jsonl)$/i.test(names[0] ?? '')) return 'hamnivo';
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
