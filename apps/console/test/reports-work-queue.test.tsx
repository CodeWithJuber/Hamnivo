import { presetPermissions } from '@hamnivo/policy';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { AnalyticsOverview } from '../src/lib/reports';
import {
  AiDraftsReport,
  OffersReport,
  ReplyTargetsReport,
} from '../src/pages/reports/WorkQueueReports';
import { renderStudio, textOf } from './render';

/**
 * Reports on the inbox work queue (H12, HNV-10-06, HNV-09-05): reply-time targets met, chats
 * offered to one person at a time, and AI drafts for review, with small groups withheld in words
 * and the 90-day keeping of offers and drafts said when a range reaches past it.
 */

beforeAll(async () => {
  await initI18n('en');
});

const held = { value: null, suppressed: true, rate: null };
const workQueue = (
  patch: Partial<Pick<AnalyticsOverview, 'replyTargets' | 'offers' | 'aiDrafts'>> = {},
): AnalyticsOverview =>
  ({
    minimumGroupSize: 5,
    replyTargets: {
      recordingSince: '2026-09-01T09:00:00.000Z',
      met: { value: 18, suppressed: false, sample: 20, rate: 0.9 },
      missed: { ...held, sample: 20 },
      stopped: { value: 6, suppressed: false },
      firstReplyMedianMinutes: { value: 12, suppressed: false, sample: 15 },
      byPriority: [
        { priority: 'urgent', replies: null, metRate: null, suppressed: true },
        { priority: 'high', replies: 0, metRate: null, suppressed: false },
        { priority: 'medium', replies: 17, metRate: 0.94, suppressed: false },
        { priority: 'low', replies: 0, metRate: null, suppressed: false },
      ],
      daily: [
        { date: '2026-09-10', replies: 12, metRate: 1, suppressed: false },
        { date: '2026-09-11', replies: 0, metRate: null, suppressed: false },
        { date: '2026-09-12', replies: 8, metRate: null, suppressed: false },
      ],
    },
    offers: {
      windowLimited: false,
      offered: { value: 40, suppressed: false },
      accepted: { value: 30, suppressed: false, sample: 38, rate: 0.79 },
      declined: { value: 6, suppressed: false, sample: 38, rate: 0.16 },
      expired: { ...held, sample: 38 },
      acceptMedianSeconds: { value: 42, suppressed: false, sample: 30 },
      leftInQueue: { ...held, sample: 34 },
      declineReasons: [
        { reason: 'at_capacity', count: 5, suppressed: false },
        { reason: 'not_my_area', count: null, suppressed: true },
      ],
      byTeam: [
        { teamId: 'team_1', name: 'Returns', offered: 40, acceptRate: 0.79, suppressed: false },
      ],
    },
    aiDrafts: {
      windowLimited: false,
      written: { value: 50, suppressed: false },
      sent: { value: 35, suppressed: false, sample: 42, rate: 0.83 },
      approved: { value: 28, suppressed: false, sample: 42, rate: 0.67 },
      edited: { value: 7, suppressed: false, sample: 42, rate: 0.17 },
      rejected: { value: 7, suppressed: false, sample: 42, rate: 0.17 },
      rejectReasons: [{ reason: 'inaccurate', count: 7, suppressed: false }],
      setAsideReasons: [{ reason: 'customer_wrote', count: 8, suppressed: false }],
      byAgent: [{ agentId: 'agt_1', name: 'Noor', written: 50, sentRate: 0.83, suppressed: false }],
    },
    ...patch,
  }) as AnalyticsOverview;

const render = (screen: React.ReactNode) =>
  renderStudio({ at: '/reports', permissions: presetPermissions('owner'), screen });

describe('reply-time targets in reports (H12)', () => {
  it('shows the share met, misses withheld in words, and the time to a first reply', async () => {
    const text = textOf(await render(<ReplyTargetsReport overview={workQueue()} />));
    expect(text).toContain('Targets met 90% Of 20 replies from a person');
    expect(text).toContain('Targets missed Small sample');
    expect(text).toContain('Median time to first reply 12 min');
    expect(text).toContain('Ended without a reply 6');
    expect(text).toContain('Reply-time targets have been recorded since');
    // By priority: a withheld row says so; days without replies are left out.
    expect(text).toContain('Urgent Small sample Small sample');
    expect(text).toContain('Medium 17 94%');
    expect(text).not.toMatch(/Sep 11|11 Sep/);
  });

  it('says nothing is recorded yet before the first clock ends', async () => {
    const empty = workQueue({
      replyTargets: {
        ...workQueue().replyTargets,
        recordingSince: null,
        met: { value: 0, suppressed: false, sample: 0, rate: null },
        daily: [],
      },
    });
    const text = textOf(await render(<ReplyTargetsReport overview={empty} />));
    expect(text).toContain('Nothing recorded yet.');
    expect(text).toContain('No reply-time clocks ended in this range.');
  });
});

describe('offers in reports (HNV-10-06)', () => {
  it('shows the share accepted, decline reasons and teams, withheld groups in words', async () => {
    const text = textOf(await render(<OffersReport overview={workQueue()} />));
    expect(text).toContain('Accepted 79% Of 38 offers answered or left to run out');
    expect(text).toContain('Declined 6 16% of 38');
    expect(text).toContain('Ran out Small sample Withheld: fewer than 5');
    expect(text).toContain('Median time to accept 42 sec');
    expect(text).toContain('Too many chats 5');
    expect(text).toContain('Not their area Small sample');
    expect(text).toContain('Returns 40 79%');
    expect(text).not.toContain('Offers are kept for 90 days');
  });

  it('says when the range reaches past the 90 days offers are kept, and when none were made', async () => {
    const none = workQueue({
      offers: {
        ...workQueue().offers,
        windowLimited: true,
        offered: { value: 0, suppressed: false },
      },
    });
    const text = textOf(await render(<OffersReport overview={none} />));
    expect(text).toContain('Offers are kept for 90 days');
    expect(text).toContain('No chats were offered in this range.');
    expect(text).not.toContain('Why people declined');
  });
});

describe('AI drafts in reports (HNV-09-05)', () => {
  it('shows the share sent, rejections and set-asides with their reasons, per agent', async () => {
    const text = textOf(await render(<AiDraftsReport overview={workQueue()} />));
    expect(text).toContain('Sent 83% Approved as written or edited, of 42 drafts');
    expect(text).toContain('Rejected 7 17% of 42');
    expect(text).toContain('It was wrong 7');
    expect(text).toContain('The customer wrote again 8');
    expect(text).toContain('Noor 50 83%');
  });

  it('says when no drafts were written', async () => {
    const none = workQueue({
      aiDrafts: {
        ...workQueue().aiDrafts,
        windowLimited: true,
        written: { value: 0, suppressed: false },
      },
    });
    const text = textOf(await render(<AiDraftsReport overview={none} />));
    expect(text).toContain('Drafts are kept for 90 days');
    expect(text).toContain('No drafts were written in this range.');
  });
});
