/**
 * Deletion tombstones (L05). Deleting a memory leaves a tombstone without its content: the slot,
 * the source message ids, keyed fingerprints of the value and when it was deleted. A replayed
 * extraction, a retried job or restored data cannot bring back what the tombstone covers. New
 * statements made after the deletion are new evidence and are judged on their own.
 */
export interface TombstoneFact {
  /** `record`: one deleted record. `subject`: everything about the customer was erased. */
  scope: 'record' | 'subject';
  key: string | null;
  sourceRefs: readonly string[];
  /** Keyed fingerprints of the deleted value (`<key version>:<hex>`). */
  fingerprints: readonly string[];
  deletedAt: Date;
}

export interface TombstoneProbe {
  key: string;
  sourceRefs: readonly string[];
  fingerprints: readonly string[];
  /** When the newest evidence for the candidate was observed. */
  observedAt: Date;
}

/**
 * The tombstone that forbids writing `probe` again, if any. A deleted memory's own source messages
 * never count as evidence again, whatever the clocks say. Otherwise a tombstone covers evidence
 * observed up to its deletion time when it erased the whole subject, or when it shares the slot or
 * the value's fingerprint. Message times are whole seconds, so a statement from the same second as
 * the deletion counts as made before it.
 */
export function coveringTombstone(
  probe: TombstoneProbe,
  tombstones: readonly TombstoneFact[],
): TombstoneFact | null {
  const observed = probe.observedAt.getTime();
  return (
    tombstones.find((t) => {
      if (t.sourceRefs.some((ref) => probe.sourceRefs.includes(ref))) return true;
      if (t.deletedAt.getTime() < observed) return false;
      if (t.scope === 'subject') return true;
      if (t.key !== null && t.key === probe.key) return true;
      return t.fingerprints.some((f) => probe.fingerprints.includes(f));
    }) ?? null
  );
}
