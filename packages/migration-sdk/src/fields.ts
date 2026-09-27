import type { FieldMapping, FieldObservation } from './types.js';

const MAX_PATHS = 400;
const MAX_DEPTH = 10;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Collects the field paths present in source records (`visitor.email`, `messages[].msg`), how many
 * records carry a non-empty value and the JSON types seen. Values themselves are never kept.
 */
export class FieldInventory {
  private readonly seen = new Map<string, { count: number; types: Set<string> }>();

  add(record: unknown): void {
    const paths = new Map<string, Set<string>>();
    const walk = (value: unknown, path: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      if (Array.isArray(value)) {
        for (const item of value) walk(item, `${path}[]`, depth + 1);
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          const name = /^[A-Za-z0-9_$-]{1,64}$/.test(key) ? key : '*';
          walk(child, path ? `${path}.${name}` : name, depth + 1);
        }
        return;
      }
      if (!path || value === null || value === '' || value === undefined) return;
      const types = paths.get(path) ?? new Set<string>();
      types.add(typeOf(value));
      paths.set(path, types);
    };
    walk(record, '', 0);
    for (const [path, types] of paths) {
      const entry = this.seen.get(path);
      if (entry) {
        entry.count += 1;
        for (const t of types) entry.types.add(t);
      } else if (this.seen.size < MAX_PATHS) {
        this.seen.set(path, { count: 1, types: new Set(types) });
      }
    }
  }

  /** Observations with each path's status from the adapter's mapping (unknown → unsupported). */
  observations(mappings: FieldMapping[]): FieldObservation[] {
    return [...this.seen.entries()]
      .map(([path, entry]) => {
        const mapping = mappings.find((m) => matchesPath(m.source, path));
        return {
          path,
          count: entry.count,
          types: [...entry.types].sort(),
          status: mapping?.status ?? 'unsupported',
          target: mapping?.target ?? null,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

const bare = (segment: string | undefined) => segment?.replace(/\[\]$/, '');

/**
 * `a.*.c` matches any one segment; `a.b` also matches `a.b.x` (a mapping covers its children).
 * Array markers only matter where the pattern has them: `attchs` covers `attchs[]`.
 */
export function matchesPath(pattern: string, path: string): boolean {
  const want = pattern.split('.');
  const have = path.split('.');
  if (have.length < want.length) return false;
  return want.every(
    (segment, i) =>
      segment === '*' ||
      segment === have[i] ||
      (!segment.endsWith('[]') && segment === bare(have[i])),
  );
}
