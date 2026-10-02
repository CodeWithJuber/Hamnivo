import { describe, expect, it } from 'vitest';
import { type ItemTally, reconcile, type SampleVerification } from '../src/index.js';

const quiet = {
  quietInbox: true,
  contactsWithAddress: 0,
  otherMessageTypes: 0,
  notesNotPrivate: 0,
};
const verified: SampleVerification = {
  sampled: 2,
  matched: 2,
  duplicateKeys: 0,
  privacyViolations: 0,
  mismatches: [],
};

const tallies: ItemTally[] = [
  { kind: 'contact', status: 'imported', reason: null, private: false, count: 2 },
  { kind: 'conversation', status: 'imported', reason: null, private: false, count: 3 },
  {
    kind: 'conversation',
    status: 'skipped',
    reason: 'duplicate_existing',
    private: false,
    count: 1,
  },
  { kind: 'message', status: 'imported', reason: null, private: false, count: 9 },
  { kind: 'message', status: 'imported', reason: null, private: true, count: 2 },
  { kind: 'message', status: 'quarantined', reason: 'missing_time', private: false, count: 1 },
  {
    kind: 'attachment',
    status: 'quarantined',
    reason: 'missing_attachment',
    private: false,
    count: 1,
  },
];

const base = {
  tallies,
  declared: null,
  found: { conversations: 4, messages: 12 },
  truncated: false,
  unidentified: 0,
  verification: verified,
  destination: quiet,
};

describe('reconciliation', () => {
  it('passes when every object is imported or explained and nothing was sent', () => {
    const report = reconcile(base);
    expect(report.gate).toBe('passed');
    expect(report.kinds.note).toMatchObject({ discovered: 2, imported: 2 });
    expect(report.kinds.message).toMatchObject({ discovered: 10, imported: 9, quarantined: 1 });
    expect(report.kinds.conversation).toMatchObject({ imported: 3, skipped: 1 });
    expect(report.reasons).toEqual(
      expect.arrayContaining([
        { kind: 'message', reason: 'missing_time', count: 1 },
        { kind: 'attachment', reason: 'missing_attachment', count: 1 },
        { kind: 'conversation', reason: 'duplicate_existing', count: 1 },
      ]),
    );
  });

  it('fails when objects were not reached (a cancelled job) or are still being written', () => {
    const report = reconcile({
      ...base,
      tallies: [
        ...tallies,
        { kind: 'message', status: 'pending', reason: null, private: false, count: 4 },
        { kind: 'message', status: 'writing', reason: null, private: false, count: 1 },
      ],
    });
    expect(report.checks.find((c) => c.code === 'all_accounted')?.ok).toBe(false);
    expect(report.gate).toBe('failed');
  });

  it('fails while objects Chatwoot refused are neither retried nor accepted', () => {
    const report = reconcile({
      ...base,
      tallies: [
        ...tallies,
        {
          kind: 'message',
          status: 'failed',
          reason: 'authority_rejected',
          private: false,
          count: 2,
        },
      ],
    });
    // Every object has a reason, but two of them could have been imported.
    expect(report.checks.find((c) => c.code === 'all_accounted')?.ok).toBe(true);
    expect(report.checks.find((c) => c.code === 'no_failures')).toEqual({
      code: 'no_failures',
      ok: false,
      detail: '2 failed',
    });
    expect(report.gate).toBe('failed');
  });

  it('fails when the export was cut short and says how much is missing', () => {
    const report = reconcile({
      ...base,
      declared: { conversations: 6, messages: 15 },
      truncated: true,
    });
    expect(report.missingFromExport).toEqual({ conversations: 2, messages: 3 });
    expect(report.checks.find((c) => c.code === 'export_complete')?.ok).toBe(false);
    expect(report.gate).toBe('failed');
  });

  it('fails when a private note came back public or anything could reach a customer', () => {
    expect(
      reconcile({ ...base, verification: { ...verified, privacyViolations: 1 } }).checks.find(
        (c) => c.code === 'private_kept_private',
      )?.ok,
    ).toBe(false);
    expect(
      reconcile({ ...base, destination: { ...quiet, contactsWithAddress: 1 } }).checks.find(
        (c) => c.code === 'nothing_sent',
      )?.ok,
    ).toBe(false);
    expect(reconcile({ ...base, destination: { ...quiet, quietInbox: false } }).gate).toBe(
      'failed',
    );
  });

  it('fails when a sampled conversation differs from the export or holds a key twice', () => {
    expect(
      reconcile({ ...base, verification: { ...verified, matched: 1 } }).checks.find(
        (c) => c.code === 'sample_matches',
      ),
    ).toMatchObject({ ok: false, detail: '1 differ' });
    expect(
      reconcile({ ...base, verification: { ...verified, duplicateKeys: 1 } }).checks.find(
        (c) => c.code === 'no_duplicates',
      )?.ok,
    ).toBe(false);
  });
});
