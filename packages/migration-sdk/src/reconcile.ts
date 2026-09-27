import type { ItemStatus } from './checkpoint.js';
import type { Counts } from './model.js';
import type { ItemKind, Reason } from './types.js';

/** Item counts grouped by kind, status, reason and privacy (what the database aggregates). */
export interface ItemTally {
  kind: ItemKind;
  status: ItemStatus;
  reason: Reason | null;
  private: boolean;
  count: number;
}

export type ReportKind = ItemKind | 'note';

export interface KindCounts {
  /** Objects found in the export (each became one item). */
  discovered: number;
  imported: number;
  skipped: number;
  quarantined: number;
  failed: number;
  /** Not reached yet (a paused or cancelled job). */
  pending: number;
  rolledBack: number;
}

/** Messages read back from Chatwoot for a sample of conversations and compared with the export. */
export interface SampleVerification {
  sampled: number;
  /** Conversations whose messages, order, original times and privacy all matched. */
  matched: number;
  /** Source keys found more than once in the sampled conversations. */
  duplicateKeys: number;
  /** Internal notes that came back public in the sample. */
  privacyViolations: number;
  mismatches: Array<{ conversationSourceId: string; problem: string }>;
}

/** What the destination looked like, checked by the job itself. */
export interface DestinationFacts {
  /** The import inbox has no webhook, no bot, no auto-assignment, no greeting and no survey. */
  quietInbox: boolean;
  /** Imported contacts carry no email or phone (so Chatwoot cannot email or text them). */
  contactsWithAddress: number;
  /** Messages written as anything other than incoming, outgoing or private notes. */
  otherMessageTypes: number;
  /** Internal notes written without Chatwoot confirming them as private. */
  notesNotPrivate: number;
}

export type CheckCode =
  | 'all_accounted'
  | 'export_complete'
  | 'no_duplicates'
  | 'private_kept_private'
  | 'nothing_sent'
  | 'sample_matches';

export interface ReconciliationCheck {
  code: CheckCode;
  ok: boolean;
  detail?: string;
}

export interface Reconciliation {
  kinds: Record<ReportKind, KindCounts>;
  reasons: Array<{ kind: ReportKind; reason: Reason; count: number }>;
  /** Declared by the export but not in it (a cut-short export). */
  missingFromExport: Partial<Counts>;
  unidentified: number;
  checks: ReconciliationCheck[];
  /** Passed only when every check passed; approving cutover otherwise needs an acknowledgement. */
  gate: 'passed' | 'failed';
}

const empty = (): KindCounts => ({
  discovered: 0,
  imported: 0,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  pending: 0,
  rolledBack: 0,
});

/**
 * The reconciliation (M08): every discovered object is imported or classified with a reason;
 * nothing unexplained, no duplicates, no private note made public, nothing sent to customers.
 * Completeness is reported per kind, never as one percentage.
 */
export function reconcile(input: {
  tallies: readonly ItemTally[];
  declared: Partial<Counts> | null;
  found: Partial<Counts>;
  truncated: boolean;
  unidentified: number;
  verification: SampleVerification | null;
  destination: DestinationFacts;
}): Reconciliation {
  const kinds: Record<ReportKind, KindCounts> = {
    contact: empty(),
    conversation: empty(),
    message: empty(),
    note: empty(),
    attachment: empty(),
  };
  const reasons = new Map<string, { kind: ReportKind; reason: Reason; count: number }>();
  let inFlight = 0;
  for (const tally of input.tallies) {
    const kind: ReportKind = tally.kind === 'message' && tally.private ? 'note' : tally.kind;
    const counts = kinds[kind];
    counts.discovered += tally.count;
    switch (tally.status) {
      case 'imported':
        counts.imported += tally.count;
        break;
      case 'skipped':
        counts.skipped += tally.count;
        break;
      case 'quarantined':
        counts.quarantined += tally.count;
        break;
      case 'failed':
        counts.failed += tally.count;
        break;
      case 'rolled_back':
        counts.rolledBack += tally.count;
        break;
      case 'writing':
        inFlight += tally.count;
        counts.pending += tally.count;
        break;
      case 'pending':
        counts.pending += tally.count;
        break;
    }
    if (tally.reason && tally.status !== 'imported') {
      const key = `${kind}:${tally.reason}`;
      const entry = reasons.get(key) ?? { kind, reason: tally.reason, count: 0 };
      entry.count += tally.count;
      reasons.set(key, entry);
    }
  }

  const missingFromExport: Partial<Counts> = {};
  for (const key of ['contacts', 'conversations', 'messages', 'attachments'] as const) {
    const declared = input.declared?.[key];
    const found = input.found[key] ?? 0;
    if (declared !== undefined && declared > found) missingFromExport[key] = declared - found;
  }

  const unexplained = Object.values(kinds).reduce(
    (sum, k) =>
      sum +
      k.discovered -
      (k.imported + k.skipped + k.quarantined + k.failed + k.rolledBack + k.pending),
    0,
  );
  const pending = Object.values(kinds).reduce((sum, k) => sum + k.pending, 0);
  const v = input.verification;
  const d = input.destination;
  const checks: ReconciliationCheck[] = [
    {
      code: 'all_accounted',
      ok: unexplained === 0 && pending === 0 && inFlight === 0 && input.unidentified === 0,
      ...(pending > 0 ? { detail: `${pending} not imported yet` } : {}),
      ...(input.unidentified > 0 ? { detail: `${input.unidentified} unreadable records` } : {}),
    },
    {
      code: 'export_complete',
      ok: !input.truncated && Object.keys(missingFromExport).length === 0,
    },
    { code: 'no_duplicates', ok: (v?.duplicateKeys ?? 0) === 0 },
    {
      code: 'private_kept_private',
      ok: d.notesNotPrivate === 0 && (v?.privacyViolations ?? 0) === 0,
    },
    {
      code: 'nothing_sent',
      ok: d.quietInbox && d.contactsWithAddress === 0 && d.otherMessageTypes === 0,
    },
    {
      code: 'sample_matches',
      ok: v !== null && v.sampled > 0 ? v.matched === v.sampled : kinds.conversation.imported === 0,
      ...(v && v.matched < v.sampled ? { detail: `${v.sampled - v.matched} differ` } : {}),
    },
  ];
  return {
    kinds,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    missingFromExport,
    unidentified: input.unidentified,
    checks,
    gate: checks.every((c) => c.ok) ? 'passed' : 'failed',
  };
}
