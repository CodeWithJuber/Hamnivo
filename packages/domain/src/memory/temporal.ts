import type { MemoryStatus } from './envelope.js';

/**
 * Temporal corrections (L03). A correction never overwrites: the old record's validity ends where
 * the new one's begins, and both stay in the history. Event time (`validFrom`, `validUntil`) and
 * transaction time (`recordedAt`, `supersededAt`) are kept apart, so "my address changed
 * yesterday" recorded today still answers both "what holds now?" and "what did we believe then?".
 */
export interface TemporalRecord {
  id: string;
  key: string;
  value: string;
  status: MemoryStatus;
  version: number;
  validFrom: Date;
  validUntil: Date | null;
  expiresAt: Date | null;
  recordedAt: Date;
  supersededAt: Date | null;
  supersedesId: string | null;
  supersededById: string | null;
}

/** Whether a record is usable at `at`: active, inside its validity window and not expired. */
export function isValidAt(record: TemporalRecord, at: Date): boolean {
  const t = at.getTime();
  return (
    record.status === 'active' &&
    record.validFrom.getTime() <= t &&
    (record.validUntil === null || record.validUntil.getTime() > t) &&
    (record.expiresAt === null || record.expiresAt.getTime() > t)
  );
}

const newestFirst = (a: TemporalRecord, b: TemporalRecord) =>
  b.validFrom.getTime() - a.validFrom.getTime() ||
  b.recordedAt.getTime() - a.recordedAt.getTime() ||
  b.version - a.version;

/**
 * The value of one slot at `at`, or null. Two active records of one slot never hold at the same
 * time (the database refuses it); if they ever did, the latest one wins and the other is reported
 * as a conflict by `conflictsOf`.
 */
export function currentOf<T extends TemporalRecord>(records: readonly T[], at: Date): T | null {
  return records.filter((r) => isValidAt(r, at)).sort(newestFirst)[0] ?? null;
}

/** The current value of every slot at `at`. */
export function resolveCurrent<T extends TemporalRecord>(
  records: readonly T[],
  at: Date,
): Map<string, T> {
  const bySlot = new Map<string, T[]>();
  for (const record of records) bySlot.set(record.key, [...(bySlot.get(record.key) ?? []), record]);
  const current = new Map<string, T>();
  for (const [key, versions] of bySlot) {
    const found = currentOf(versions, at);
    if (found) current.set(key, found);
  }
  return current;
}

/**
 * Bitemporal view: what Hamnivo believed at `asOf` (transaction time) about the value at `at`
 * (event time). A record was believed from when it was recorded until it was superseded.
 */
export function believedAt<T extends TemporalRecord>(
  records: readonly T[],
  query: { at: Date; asOf: Date },
): T | null {
  const asOf = query.asOf.getTime();
  const at = query.at.getTime();
  return (
    records
      .filter((r) => {
        if (r.status === 'pending' || r.recordedAt.getTime() > asOf) return false;
        if (r.validFrom.getTime() > at) return false;
        // Closed after `asOf`: at that time the value still looked open-ended.
        if (r.supersededAt !== null && r.supersededAt.getTime() > asOf) return true;
        return r.validUntil === null || r.validUntil.getTime() > at;
      })
      .sort(newestFirst)[0] ?? null
  );
}

export type HistoryState = 'current' | 'pending' | 'superseded' | 'outdated' | 'expired' | 'future';

/** One slot's versions, newest first, each with how it stands at `at`. */
export function historyOf<T extends TemporalRecord>(
  records: readonly T[],
  key: string,
  at: Date,
): Array<T & { state: HistoryState }> {
  return records
    .filter((r) => r.key === key)
    .sort((a, b) => b.version - a.version || newestFirst(a, b))
    .map((record) => {
      let state: HistoryState;
      if (record.status === 'pending') state = 'pending';
      else if (record.status === 'superseded') state = 'superseded';
      else if (record.status === 'outdated') state = 'outdated';
      else if (record.expiresAt !== null && record.expiresAt.getTime() <= at.getTime())
        state = 'expired';
      else if (record.validFrom.getTime() > at.getTime()) state = 'future';
      else state = 'current';
      return { ...record, state };
    });
}

export interface MemoryConflict<T> {
  key: string;
  /** The value in use. */
  current: T | null;
  /** Newer evidence that disagrees and waits for review; never used until confirmed. */
  candidate: T;
}

/** Slots where newer evidence disagrees with what is remembered (HNV-15-03). */
export function conflictsOf<T extends TemporalRecord>(
  records: readonly T[],
  at: Date,
): MemoryConflict<T>[] {
  return records
    .filter((r) => r.status === 'pending')
    .map((candidate) => ({
      key: candidate.key,
      candidate,
      current: currentOf(
        records.filter((r) => r.key === candidate.key),
        at,
      ),
    }));
}

export type SupersessionPlan =
  | { ok: true; oldValidUntil: Date; newValidFrom: Date; newVersion: number }
  | { ok: false; reason: 'not_current' | 'starts_before_old' | 'starts_in_future' };

/**
 * How a correction replaces `old`: the new value holds from `validFrom` (default now), and the old
 * one's validity ends there. A correction cannot start before the value it corrects, or later
 * than now.
 */
export function planSupersession(
  old: TemporalRecord,
  input: { now: Date; validFrom?: Date },
): SupersessionPlan {
  if (old.status !== 'active' && old.status !== 'pending')
    return { ok: false, reason: 'not_current' };
  const validFrom = input.validFrom ?? input.now;
  if (validFrom.getTime() > input.now.getTime()) return { ok: false, reason: 'starts_in_future' };
  if (validFrom.getTime() < old.validFrom.getTime()) {
    return { ok: false, reason: 'starts_before_old' };
  }
  return {
    ok: true,
    oldValidUntil: validFrom,
    newValidFrom: validFrom,
    newVersion: old.version + 1,
  };
}
