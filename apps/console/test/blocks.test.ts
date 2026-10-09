import { describe, expect, it } from 'vitest';
import { blockingAr } from '../src/i18n/blocking/ar';
import { blockingEn } from '../src/i18n/blocking/en';
import { blockingHi } from '../src/i18n/blocking/hi';
import { blockingUr } from '../src/i18n/blocking/ur';
import { ApiError } from '../src/lib/api';
import {
  BLOCK_DURATIONS,
  expiryFor,
  fieldError,
  isActive,
  standingOf,
  type VisitorBlock,
} from '../src/lib/blocks';
import { noTickets, ticketsByPriority, ticketsBySource } from '../src/lib/reports';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const HOUR = 3_600_000;

const block = (patch: Partial<VisitorBlock> = {}): VisitorBlock => ({
  id: 'blk_1',
  brandId: 'brand_1',
  who: 'Visitor 7F3A',
  signedIn: false,
  customerId: 'cus_1',
  visitorId: null,
  conversationId: 'conv_1',
  reason: 'Abusive messages',
  createdBy: { id: 'staff_1', name: 'Sara Staff' },
  createdAt: new Date(NOW - HOUR).toISOString(),
  expiresAt: new Date(NOW + 23 * HOUR).toISOString(),
  liftedAt: null,
  liftedBy: null,
  active: true,
  ...patch,
});

describe('how long a block lasts', () => {
  it('offers 24 hours, 7 days, 30 days and until unblocked, in that order', () => {
    expect(BLOCK_DURATIONS).toEqual(['day', 'week', 'month', 'always']);
  });

  it('ends when the gateway says it does, or never', () => {
    const now = new Date(NOW);
    expect(expiryFor('day', now)?.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    expect(expiryFor('week', now)?.toISOString()).toBe('2026-10-16T12:00:00.000Z');
    expect(expiryFor('month', now)?.toISOString()).toBe('2026-11-08T12:00:00.000Z');
    expect(expiryFor('always', now)).toBeNull();
  });

  it('names every choice in every language, never copied from the English', () => {
    expect(blockingEn.durations).toEqual({
      day: '24 hours',
      week: '7 days',
      month: '30 days',
      always: 'Until unblocked',
    });
    for (const tree of [blockingAr, blockingHi, blockingUr]) {
      for (const duration of BLOCK_DURATIONS) {
        expect(tree.durations[duration].trim()).not.toBe('');
        expect(tree.durations[duration]).not.toBe(blockingEn.durations[duration]);
      }
    }
  });
});

describe('where a block stands', () => {
  it('runs until a time, or until someone lifts it', () => {
    expect(standingOf(block(), NOW)).toEqual({
      kind: 'until',
      at: new Date(NOW + 23 * HOUR).toISOString(),
    });
    expect(standingOf(block({ expiresAt: null }), NOW)).toEqual({ kind: 'never' });
    expect(isActive(block(), NOW)).toBe(true);
    expect(isActive(block({ expiresAt: null }), NOW)).toBe(true);
  });

  it('has ended on its own once its time has passed', () => {
    const ended = block({ expiresAt: new Date(NOW - 1).toISOString(), active: false });
    expect(standingOf(ended, NOW)).toEqual({ kind: 'expired', at: ended.expiresAt });
    expect(isActive(ended, NOW)).toBe(false);
  });

  it('says who lifted it and when, whatever its expiry was', () => {
    const lifted = block({
      expiresAt: null,
      liftedAt: new Date(NOW - 60_000).toISOString(),
      liftedBy: { id: 'staff_2', name: 'Omar' },
      active: false,
    });
    expect(standingOf(lifted, NOW)).toEqual({ kind: 'lifted', at: lifted.liftedAt, by: 'Omar' });
    expect(standingOf({ ...lifted, liftedBy: null }, NOW)).toMatchObject({ by: null });
    expect(isActive(lifted, NOW)).toBe(false);
  });
});

describe('the gateway’s field messages', () => {
  it('finds the message for a field, and nothing for other errors', () => {
    const refused = new ApiError(422, 'VALIDATION_FAILED', {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'VALIDATION_FAILED',
      retryable: false,
      fields: [{ path: 'reason', message: 'Too big: expected string to have <=500 characters' }],
    } as never);
    expect(fieldError(refused, 'reason')).toBe('Too big: expected string to have <=500 characters');
    expect(fieldError(refused, 'duration')).toBeUndefined();
    expect(fieldError(new Error('boom'), 'reason')).toBeUndefined();
    expect(fieldError(null, 'reason')).toBeUndefined();
  });
});

describe('the blocked visitor’s side, as Studio explains it', () => {
  it('says the visitor only sees that chat isn’t available', () => {
    expect(blockingEn.dialog.explanation).toBe(
      'They will see that chat isn’t available. Clearing their browser gets around a block; signed-in customers stay blocked on any device.',
    );
  });
});

describe('the Tickets report', () => {
  const metric = (value: number | null) => ({ value, suppressed: value === null, sample: 9 });
  const tickets = {
    created: metric(6),
    closed: metric(2),
    openNow: metric(4),
    closeMedianSeconds: metric(null),
    byPriority: [
      { priority: null, count: 3, suppressed: false },
      { priority: 'low' as const, count: null, suppressed: true },
      { priority: 'urgent' as const, count: 2, suppressed: false },
    ],
    bySource: [
      { source: 'automation' as const, count: null, suppressed: true },
      { source: 'offline_form' as const, count: 5, suppressed: false },
      { source: 'staff' as const, count: null, suppressed: true },
    ],
  };

  it('lists priorities highest first, then tickets with none', () => {
    expect(ticketsByPriority(tickets).map((row) => row.priority)).toEqual(['urgent', 'low', null]);
  });

  it('lists the contact form, staff, then automations', () => {
    expect(ticketsBySource(tickets).map((row) => row.source)).toEqual([
      'offline_form',
      'staff',
      'automation',
    ]);
  });

  it('is empty only when nothing was opened, closed or is open, not when a count is withheld', () => {
    expect(noTickets({ tickets })).toBe(false);
    const none = { ...tickets, created: metric(0), closed: metric(0), openNow: metric(0) };
    expect(noTickets({ tickets: none })).toBe(true);
    expect(noTickets({ tickets: { ...none, openNow: metric(null) } })).toBe(false);
  });
});
