/**
 * The host → frame messages of the bridge, checked without zod, for the chat's first script. It
 * accepts and returns exactly what `HostToFrame.safeParse` does (unknown keys dropped), and
 * test/bridge-check.test.ts holds the two to the same answers, so they cannot drift apart. The
 * schema in bridge.ts stays the definition; change both together.
 */
import type { HostToFrame } from './bridge.js';
import { BRIDGE_SOURCE, BRIDGE_VERSION } from './constants.js';

type Raw = Record<string, unknown>;
type PageContextValue = Extract<HostToFrame, { type: 'set-context' }>['context'];

const isRecord = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Code points, as zod (4.6) measures a string for `.min()` and `.max()`: an emoji counts once. */
const codePoints = (value: string) => {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
};

/** A string of `min` to `max` code points. */
const text = (value: unknown, max: number, min = 0): value is string => {
  if (typeof value !== 'string') return false;
  const length = codePoints(value);
  return length >= min && length <= max;
};

const optional = <T>(value: unknown, check: (v: unknown) => v is T): value is T | undefined =>
  value === undefined || check(value);

const bool = (value: unknown): value is boolean => typeof value === 'boolean';

const VISITOR_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const REFERENCE_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    // Not a URL: the message is refused.
    return false;
  }
}

/** `PageContext`: optional url, title, page type and named references, nothing else kept. */
function pageContext(value: unknown): PageContextValue | null {
  if (!isRecord(value)) return null;
  const { url, title, pageType, references } = value;
  if (url !== undefined && !(text(url, 2000) && isUrl(url))) return null;
  if (!optional(title, (v): v is string => text(v, 300))) return null;
  if (!optional(pageType, (v): v is string => text(v, 60))) return null;
  let names: Record<string, string> | undefined;
  if (references !== undefined) {
    if (!isRecord(references)) return null;
    names = {};
    for (const [key, entry] of Object.entries(references)) {
      if (!REFERENCE_NAME.test(key) || !text(entry, 200)) return null;
      names[key] = entry;
    }
  }
  return {
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(pageType !== undefined ? { pageType } : {}),
    ...(names !== undefined ? { references: names } : {}),
  };
}

/** A message from the host page, as `HostToFrame` reads it, or null when it is not one. */
export function readHostToFrame(data: unknown): HostToFrame | null {
  if (!isRecord(data)) return null;
  const { source, v, instanceId, type } = data;
  if (source !== BRIDGE_SOURCE || v !== BRIDGE_VERSION || !text(instanceId, 64)) return null;
  const base = { source: BRIDGE_SOURCE, v: BRIDGE_VERSION, instanceId } as const;
  switch (type) {
    case 'open':
    case 'close':
      return { ...base, type };
    case 'identify':
      return text(data.assertion, 4096, 20) && text(data.requestId, 64)
        ? { ...base, type, assertion: data.assertion, requestId: data.requestId }
        : null;
    case 'reset':
      return text(data.requestId, 64) ? { ...base, type, requestId: data.requestId } : null;
    case 'set-context': {
      const context = pageContext(data.context);
      return context ? { ...base, type, context } : null;
    }
    case 'send-message':
      return text(data.text, 10_000, 1) && text(data.requestId, 64)
        ? { ...base, type, text: data.text, requestId: data.requestId }
        : null;
    case 'set-locale':
      return text(data.locale, 35) ? { ...base, type, locale: data.locale } : null;
    case 'prefill':
      return text(data.text, 2000, 1) ? { ...base, type, text: data.text } : null;
    case 'proactive':
      return text(data.triggerId, 32) ? { ...base, type, triggerId: data.triggerId } : null;
    case 'visitor':
      return typeof data.key === 'string' && VISITOR_KEY.test(data.key)
        ? { ...base, type, key: data.key }
        : null;
    case 'env': {
      const { theme, fullScreen, expanded, safeBottom } = data;
      if (theme !== undefined && theme !== 'light' && theme !== 'dark') return null;
      if (!optional(fullScreen, bool) || !optional(expanded, bool)) return null;
      if (
        safeBottom !== undefined &&
        !(
          typeof safeBottom === 'number' &&
          Number.isFinite(safeBottom) &&
          safeBottom >= 0 &&
          safeBottom <= 200
        )
      )
        return null;
      return {
        ...base,
        type,
        ...(theme !== undefined ? { theme } : {}),
        ...(fullScreen !== undefined ? { fullScreen } : {}),
        ...(expanded !== undefined ? { expanded } : {}),
        ...(safeBottom !== undefined ? { safeBottom } : {}),
      };
    }
    default:
      return null;
  }
}
