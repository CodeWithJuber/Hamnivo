import { describe, expect, it } from 'vitest';
import {
  believedAt,
  conflictsOf,
  currentOf,
  historyOf,
  isValidAt,
  planSupersession,
  resolveCurrent,
  type TemporalRecord,
} from '../src/index.js';

const at = (iso: string) => new Date(`2026-09-${iso}Z`);

const record = (
  overrides: Partial<TemporalRecord> & Pick<TemporalRecord, 'id'>,
): TemporalRecord => ({
  key: 'delivery_note',
  value: 'Call at reception',
  status: 'active',
  version: 1,
  validFrom: at('01T10:00:00'),
  validUntil: null,
  expiresAt: null,
  recordedAt: at('01T10:00:00'),
  supersededAt: null,
  supersedesId: null,
  supersededById: null,
  ...overrides,
});

/**
 * The customer's address changed on the 25th, but they told us on the 27th: the old value was
 * recorded on the 1st, the correction on the 27th with validity from the 25th.
 */
const original = record({
  id: 'v1',
  value: 'Old address',
  key: 'delivery_note',
  status: 'superseded',
  validUntil: at('25T00:00:00'),
  supersededAt: at('27T09:00:00'),
  supersededById: 'v2',
});
const corrected = record({
  id: 'v2',
  value: 'New address',
  version: 2,
  validFrom: at('25T00:00:00'),
  recordedAt: at('27T09:00:00'),
  supersedesId: 'v1',
});

describe('temporal corrections', () => {
  it('uses only active records inside their validity window and before expiry', () => {
    expect(isValidAt(corrected, at('26T00:00:00'))).toBe(true);
    expect(isValidAt(corrected, at('24T00:00:00'))).toBe(false);
    expect(isValidAt(original, at('10T00:00:00'))).toBe(false); // superseded: history only
    expect(isValidAt({ ...corrected, expiresAt: at('26T00:00:00') }, at('27T00:00:00'))).toBe(
      false,
    );
    expect(isValidAt({ ...corrected, status: 'pending' }, at('27T00:00:00'))).toBe(false);
    expect(isValidAt({ ...corrected, status: 'outdated' }, at('27T00:00:00'))).toBe(false);
  });

  it('selects the one current value and never both', () => {
    expect(currentOf([original, corrected], at('27T12:00:00'))?.id).toBe('v2');
    const other = record({ id: 'p1', key: 'contact_method', value: 'Email' });
    const current = resolveCurrent([original, corrected, other], at('27T12:00:00'));
    expect([...current.keys()].sort()).toEqual(['contact_method', 'delivery_note']);
    expect(current.get('delivery_note')?.value).toBe('New address');
  });

  it('answers what was believed then, as well as what holds now (bitemporal)', () => {
    // On the 26th we still believed the old address held on the 26th.
    expect(
      believedAt([original, corrected], { at: at('26T00:00:00'), asOf: at('26T12:00:00') })?.id,
    ).toBe('v1');
    // Since the correction, we know the new address held on the 26th.
    expect(
      believedAt([original, corrected], { at: at('26T00:00:00'), asOf: at('27T12:00:00') })?.id,
    ).toBe('v2');
    // And the old one still answers for the 10th.
    expect(
      believedAt([original, corrected], { at: at('10T00:00:00'), asOf: at('27T12:00:00') })?.id,
    ).toBe('v1');
  });

  it('keeps the history inspectable, newest first, with how each version ended', () => {
    const outdated = record({
      id: 'c1',
      key: 'contact_method',
      status: 'outdated',
      validUntil: at('20T00:00:00'),
    });
    const pending = record({ id: 'v3', value: 'Leave at the door', version: 3, status: 'pending' });
    const expired = record({ id: 'e1', key: 'open_issue', expiresAt: at('20T00:00:00') });
    const history = historyOf(
      [original, corrected, pending, outdated, expired],
      'delivery_note',
      at('27T12:00:00'),
    );
    expect(history.map((h) => [h.id, h.state])).toEqual([
      ['v3', 'pending'],
      ['v2', 'current'],
      ['v1', 'superseded'],
    ]);
    expect(historyOf([outdated], 'contact_method', at('27T12:00:00'))[0]?.state).toBe('outdated');
    expect(historyOf([expired], 'open_issue', at('27T12:00:00'))[0]?.state).toBe('expired');
  });

  it('exposes a disagreeing proposal next to the current value (HNV-15-03)', () => {
    const pending = record({ id: 'v3', value: 'Leave at the door', version: 3, status: 'pending' });
    expect(conflictsOf([original, corrected, pending], at('27T12:00:00'))).toEqual([
      { key: 'delivery_note', candidate: pending, current: corrected },
    ]);
    expect(conflictsOf([original, corrected], at('27T12:00:00'))).toEqual([]);
  });

  it('plans a supersession that closes the old validity where the new one starts', () => {
    const now = at('27T12:00:00');
    expect(planSupersession(corrected, { now })).toEqual({
      ok: true,
      oldValidUntil: now,
      newValidFrom: now,
      newVersion: 3,
    });
    expect(planSupersession(corrected, { now, validFrom: at('26T00:00:00') })).toMatchObject({
      ok: true,
      oldValidUntil: at('26T00:00:00'),
    });
    expect(planSupersession(corrected, { now, validFrom: at('24T00:00:00') })).toEqual({
      ok: false,
      reason: 'starts_before_old',
    });
    expect(planSupersession(corrected, { now, validFrom: at('28T00:00:00') })).toEqual({
      ok: false,
      reason: 'starts_in_future',
    });
    expect(planSupersession(original, { now })).toEqual({ ok: false, reason: 'not_current' });
  });
});
