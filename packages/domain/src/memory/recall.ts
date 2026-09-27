import type { EvidenceStatus, MemoryKind, MemorySourceType } from './envelope.js';
import { memorySlot } from './slots.js';
import { isValidAt, type TemporalRecord } from './temporal.js';

/**
 * Recall into an AI reply (G19): only current values, one per slot, within a size budget. The
 * gateway decides eligibility first (consent, subject, brand, purpose, conversation scope); this
 * picks what fits and renders it as memories, never as things the customer said in this chat.
 */
export interface RecallCandidate extends TemporalRecord {
  kind: MemoryKind;
  sourceType: MemorySourceType;
  evidenceStatus: EvidenceStatus;
  observedAt: Date;
  /** Relevance to the customer's latest words (higher is better). */
  score: number;
}

export interface RecallBudget {
  maxItems: number;
  /** Characters of rendered memory lines, together. */
  maxChars: number;
}

export interface RecallSelection<T extends RecallCandidate> {
  items: T[];
  /** Why candidates were left out, as counts (no content). */
  withheld: { invalid: number; duplicateSlot: number; overBudget: number };
}

const SOURCE_WORDS: Record<MemorySourceType, string> = {
  customer_statement: 'customer message',
  customer_control: 'set by the customer',
  staff_entry: 'confirmed by staff',
  agent_inference: 'inferred',
  system_record: 'system record',
  import: 'imported',
};

/**
 * One memory as the model sees it: numbered for citation, labelled, with where it came from and
 * when. Claims say plainly that they are not verified.
 */
export function renderMemoryLine(item: RecallCandidate, index: number): string {
  const label = memorySlot(item.key)?.label ?? item.key;
  const date = item.observedAt.toISOString().slice(0, 10);
  const claim = item.kind === 'claim' || item.evidenceStatus === 'unknown' ? ', not verified' : '';
  return `[M${index + 1}] ${label}: ${item.value} (${SOURCE_WORDS[item.sourceType]}, ${date}${claim})`;
}

/** Profile slots first, then relevance, then the most recently recorded. */
const ranked = (a: RecallCandidate, b: RecallCandidate) => {
  const profile =
    Number(memorySlot(b.key)?.profile ?? false) - Number(memorySlot(a.key)?.profile ?? false);
  return profile || b.score - a.score || b.recordedAt.getTime() - a.recordedAt.getTime();
};

export function selectRecall<T extends RecallCandidate>(
  candidates: readonly T[],
  budget: RecallBudget,
  at: Date,
): RecallSelection<T> {
  const withheld = { invalid: 0, duplicateSlot: 0, overBudget: 0 };
  const seen = new Set<string>();
  const items: T[] = [];
  let chars = 0;
  for (const candidate of [...candidates].sort(ranked)) {
    if (!isValidAt(candidate, at)) {
      withheld.invalid += 1;
      continue;
    }
    if (seen.has(candidate.key)) {
      withheld.duplicateSlot += 1;
      continue;
    }
    const length = renderMemoryLine(candidate, items.length).length + 1;
    if (items.length >= budget.maxItems || chars + length > budget.maxChars) {
      withheld.overBudget += 1;
      continue;
    }
    seen.add(candidate.key);
    items.push(candidate);
    chars += length;
  }
  return { items, withheld };
}

/**
 * Removes memory citations (`[M1]`) from a reply and returns the memories it cited, in order.
 * Numbers that match nothing that was recalled are dropped.
 */
export function applyMemoryCitations<T>(
  text: string,
  items: readonly T[],
): { text: string; cited: T[] } {
  const cited: T[] = [];
  const replaced = text.replace(/\[\s*M\s*(\d{1,2})\s*\]/gi, (_, n: string) => {
    const item = items[Number(n) - 1];
    if (item !== undefined && !cited.includes(item)) cited.push(item);
    return '';
  });
  const cleaned = replaced
    .replace(/[ \t]+([.,;:!?؟۔।])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .trim();
  return { text: cleaned, cited };
}

/**
 * Whether a reply may enter a shared cache (K09). Anything built with personal memory is personal
 * to one customer and is never shared, whatever else the cache policy allows.
 */
export function sharedCacheEligibility(context: {
  memoryItems: number;
}): { eligible: true } | { eligible: false; reason: 'personal_memory' } {
  return context.memoryItems > 0
    ? { eligible: false, reason: 'personal_memory' }
    : { eligible: true };
}
