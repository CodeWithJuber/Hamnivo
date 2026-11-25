// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, useContext } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { InboxConversation, InboxDetail } from '../src/lib/inbox';
import type { SlaPolicy } from '../src/lib/sla';
import { ConversationPane } from '../src/pages/inbox/ConversationPane';
import { InboxPage } from '../src/pages/inbox/InboxPage';
import { HoursPage } from '../src/pages/settings/HoursPage';
import { fakeGateway, mountStudio, SELF_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');
const owner = presetPermissions('owner');

/** The inbox has an outlet of its own (for the open conversation), so it is drawn once only. */
const Inside = createContext(false);
function Once({ children }: { children: ReactNode }) {
  return useContext(Inside) ? null : <Inside.Provider value>{children}</Inside.Provider>;
}
const inbox = (
  <Once>
    <InboxPage />
  </Once>
);

const NOW = new Date().toISOString();
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const row = (patch: Partial<InboxConversation> = {}): InboxConversation => ({
  id: 'conv_1',
  brand: { id: 'brd_1', name: 'Noor Books' },
  inboxId: 'inb_1',
  channel: 'chat',
  status: 'open',
  customerStatus: 'open',
  ownerMode: 'WAITING_HUMAN',
  ownershipEpoch: 3,
  owner: { kind: 'none' } as InboxConversation['owner'],
  ownerReason: 'customer_request',
  ownerChangedAt: NOW,
  team: null,
  customer: { displayName: 'Aisha Khan', identity: 'anonymous', language: 'en' },
  lastMessage: { preview: 'Where is my order?', at: NOW, from: 'customer' },
  labels: [],
  snoozedUntil: null,
  ticket: null,
  priority: null,
  waitingSince: NOW,
  sla: null,
  aiDraftReady: false,
  offer: null,
  replyWindowClosesAt: null,
  unreadCount: 0,
  lastActivityAt: NOW,
  createdAt: NOW,
  ...patch,
});

const running = (minutes: number, target = 60) => ({
  kind: 'first_reply' as const,
  state: 'running' as const,
  dueAt: inMinutes(minutes),
  businessMinutesLeft: minutes,
  breached: minutes < 0,
  targetMinutes: target,
});

const counts = { mine: 0, unassigned: 3, overdue: 1, ai: 0, team: 0, tickets: 0, all: 3 };

describe('reply-time targets in the queue (H12)', () => {
  it('shows when a reply is due, in words, and has an Overdue queue with its count', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': {
        json: {
          items: [
            row({ id: 'conv_1', sla: running(-12) }),
            row({
              id: 'conv_2',
              sla: running(8),
              customer: { displayName: 'Bilal', identity: 'anonymous', language: null },
            }),
            row({
              id: 'conv_3',
              status: 'snoozed',
              sla: { ...running(30), state: 'paused', dueAt: null },
              customer: { displayName: 'Chen', identity: 'anonymous', language: null },
            }),
          ],
          nextCursor: null,
          counts,
        },
      },
      'GET /v1/inbox/urgent': { json: { items: [], total: 0 } },
    });
    const { router } = await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const [late, soon, paused] = await screen.findAllByTestId('inbox-row');
    const badge = (el: HTMLElement | undefined) =>
      (el as HTMLElement).querySelector('[data-testid="sla-badge"]') as HTMLElement;
    expect(badge(late).textContent).toBe('Overdue by 12 min');
    expect(badge(late).dataset.sla).toBe('overdue');
    expect(badge(late).querySelector('svg')).toBeTruthy();
    expect(badge(soon).textContent).toBe('Reply due in 8 min');
    expect(badge(soon).dataset.sla).toBe('dueSoon');
    expect(badge(paused).textContent).toBe('Reply time paused');

    const queues = screen.getByRole('navigation', { name: 'Queues' });
    const pill = within(queues).getByRole('link', { name: /Overdue/ });
    await waitFor(() => expect(pill.textContent).toBe('Overdue1'));
    await userEvent.setup({ delay: null }).click(pill);
    await waitFor(() => expect(router.state.location.search).toEqual({ queue: 'overdue' }));
    await waitFor(() =>
      expect(
        gateway.to('GET', '/v1/inbox/conversations').some((c) => c.query.queue === 'overdue'),
      ).toBe(true),
    );
  });
});

describe('urgent conversations nobody has taken (HNV-08-02)', () => {
  it('lists them above the queue with a Claim button that opens the conversation', async () => {
    const urgent = row({ id: 'conv_9', priority: 'urgent', sla: running(2, 5) });
    let listed = [urgent];
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': () => ({ json: { items: listed, total: listed.length * 7 } }),
      // Claimed, it leaves the list, which reloads before the claim's answer is handled.
      'POST /v1/inbox/conversations/conv_9/assign': () => {
        listed = [];
        return {
          json: {
            ...urgent,
            ownerMode: 'HUMAN_ACTIVE',
            owner: { kind: 'staff', staffMemberId: SELF_ID, displayName: 'Omar Agent' },
          },
        };
      },
    });
    const { router } = await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const section = await screen.findByTestId('urgent-section');
    expect(
      within(section).getByRole('heading', { name: /Urgent, nobody has taken it/ }),
    ).toBeTruthy();
    expect(section.textContent).toContain('7 urgent');
    expect(section.textContent).toContain('Asked for a person');
    expect(section.textContent).toContain('Reply due in 2 min');
    expect(section.textContent).toContain('Showing 1 of 7.');
    await userEvent
      .setup()
      .click(
        within(section).getByRole('button', { name: 'Claim the conversation with Aisha Khan' }),
      );
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/inbox/conversations/conv_9/assign')[0]?.body).toEqual({
        to: { kind: 'me' },
        expectedEpoch: 3,
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox/conv_9'));
  });

  it('says who won when a claim loses', async () => {
    let urgentItems = [row({ id: 'conv_9', priority: 'urgent' })];
    fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': () => ({
        json: { items: urgentItems, total: urgentItems.length },
      }),
      'POST /v1/inbox/conversations/conv_9/assign': () => {
        urgentItems = [];
        return {
          problem: {
            status: 409,
            code: 'OWNERSHIP_CHANGED',
            currentOwner: { kind: 'staff', displayName: 'Rayan Lead', ownershipEpoch: 4 },
          },
        };
      },
    });
    await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const section = await screen.findByTestId('urgent-section');
    await userEvent.setup({ delay: null }).click(within(section).getByTestId('urgent-claim'));
    const lost = await screen.findByTestId('urgent-lost');
    expect(lost.getAttribute('role')).toBe('alert');
    expect(lost.textContent).toBe('Rayan Lead already took this conversation.');
  });

  it('is not shown to people who cannot take conversations', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [row()], nextCursor: null, counts } },
    });
    const viewer = agent.filter((p) => p !== 'conversations.takeover');
    await mountStudio({ at: '/inbox', permissions: viewer, screen: inbox });
    await screen.findAllByTestId('inbox-row');
    expect(screen.queryByTestId('urgent-section')).toBeNull();
    expect(gateway.to('GET', '/v1/inbox/urgent')).toHaveLength(0);
  });
});

describe('a claim that lost in the conversation (HNV-08-06)', () => {
  it('names the person who has it now', async () => {
    const detail: InboxDetail = {
      ...row({ sla: running(20) }),
      permissions: {
        reply: true,
        note: true,
        takeover: true,
        assign: false,
        status: true,
        tag: true,
        review: false,
        bulk: false,
      },
      presence: [],
      aiAvailable: true,
      customerTyping: false,
    };
    fakeGateway({
      'GET /v1/inbox/conversations/conv_1': { json: detail },
      'POST /v1/inbox/conversations/conv_1/assign': {
        problem: {
          status: 409,
          code: 'OWNERSHIP_CHANGED',
          currentOwner: { kind: 'staff', displayName: 'Rayan Lead', ownershipEpoch: 4 },
        },
      },
    });
    await mountStudio({ at: '/inbox/conv_1', permissions: agent, screen: <ConversationPane /> });
    const title = await screen.findByTestId('conversation-title');
    const header = title.closest('header') as HTMLElement;
    expect(within(header).getByTestId('sla-badge').textContent).toBe('Reply due in 20 min');
    await userEvent.setup({ delay: null }).click(await screen.findByTestId('take-over'));
    expect((await screen.findByTestId('claim-lost')).textContent).toBe(
      'Rayan Lead already took this conversation.',
    );
  });
});

describe('setting reply-time targets on the business hours page', () => {
  const policy: SlaPolicy = {
    enabled: false,
    targets: {
      urgent: { firstReplyMinutes: null, nextReplyMinutes: null },
      high: { firstReplyMinutes: null, nextReplyMinutes: null },
      medium: { firstReplyMinutes: null, nextReplyMinutes: null },
      low: { firstReplyMinutes: null, nextReplyMinutes: null },
    },
    overdue: { alertLeads: false, moveAfterMinutes: null, moveTo: { kind: 'queue' } },
    updatedAt: null,
  };
  const brand = {
    id: 'brd_1',
    workspaceId: 'wsp_1',
    name: 'Noor Books',
    widgetId: 'wid_1',
    allowedOrigins: [],
    businessHours: null,
    status: 'active',
    createdAt: NOW,
  };

  it('saves whole numbers in minutes, and explains a value it cannot save', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/brands': { json: { items: [brand] } },
      'GET /v1/admin/brands/brd_1/sla-policy': { json: policy },
      'PUT /v1/admin/brands/brd_1/sla-policy': (call) => ({
        json: { ...(call.body as object), updatedAt: NOW },
      }),
    });
    await mountStudio({ at: '/hours', permissions: owner, screen: <HoursPage /> });
    const form = await screen.findByTestId('reply-targets');
    const user = userEvent.setup({ delay: null });
    await user.click(within(form).getByLabelText('Use reply-time targets for this brand'));
    await user.type(within(form).getByLabelText('First reply within for Urgent'), '5');
    await user.type(within(form).getByLabelText('Next reply within for Urgent'), '0');
    await user.type(within(form).getByLabelText('First reply within for Medium'), '2');
    await user.selectOptions(
      within(form).getByLabelText('Unit for First reply within, Medium'),
      'hours',
    );
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));
    expect(
      await within(form).findByText(
        'Next reply within for Urgent: enter a whole number from 1 minute to 7 days, or leave it empty.',
      ),
    ).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/sla-policy')).toHaveLength(0);

    const next = within(form).getByLabelText('Next reply within for Urgent');
    await user.clear(next);
    await user.type(next, '15');
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/sla-policy')[0]?.body).toEqual({
        enabled: true,
        targets: {
          urgent: { firstReplyMinutes: 5, nextReplyMinutes: 15 },
          high: { firstReplyMinutes: null, nextReplyMinutes: null },
          medium: { firstReplyMinutes: 120, nextReplyMinutes: null },
          low: { firstReplyMinutes: null, nextReplyMinutes: null },
        },
        overdue: { alertLeads: false, moveAfterMinutes: null, moveTo: { kind: 'queue' } },
      }),
    );
  });

  it('alerts leads and moves an overdue conversation to a team that takes the brand (ADR 0016)', async () => {
    const team = (id: string, name: string, over: object = {}) => ({
      id,
      name,
      workspaceId: 'wsp_1',
      status: 'active',
      members: [],
      assignmentMode: 'offer',
      offerTimeoutSeconds: 60,
      createdAt: NOW,
      ...over,
    });
    const gateway = fakeGateway({
      'GET /v1/admin/brands': { json: { items: [brand] } },
      'GET /v1/admin/brands/brd_1/sla-policy': {
        json: {
          ...policy,
          enabled: true,
          targets: { ...policy.targets, medium: { firstReplyMinutes: 30, nextReplyMinutes: null } },
        },
      },
      'GET /v1/admin/teams': {
        json: {
          items: [
            team('team_care', 'Care'),
            team('team_old', 'Old', { status: 'archived' }),
            team('team_far', 'Elsewhere', { workspaceId: 'wsp_2' }),
            team('team_all', 'Everyone', { workspaceId: null }),
          ],
        },
      },
      'PUT /v1/admin/brands/brd_1/sla-policy': (call) => ({
        json: { ...(call.body as object), updatedAt: NOW },
      }),
    });
    await mountStudio({ at: '/hours', permissions: owner, screen: <HoursPage /> });
    const form = await screen.findByTestId('reply-targets');
    const user = userEvent.setup({ delay: null });
    expect(
      within(form).getByRole('group', { name: 'When a conversation goes past its target' }),
    ).toBeTruthy();
    await user.click(within(form).getByLabelText('Alert team leads right away'));
    await user.click(within(form).getByLabelText('Move it if nobody replies'));
    const after = within(form).getByLabelText('Move it after') as HTMLInputElement;
    expect(after.value).toBe('15');
    // Only teams that can take the brand's conversations are offered.
    const to = within(form).getByLabelText('Move it to') as HTMLSelectElement;
    expect([...to.options].map((o) => o.textContent)).toEqual([
      'The queue (it keeps its team)',
      'The Care team',
      'The Everyone team',
    ]);
    await user.clear(after);
    await user.type(after, 'soon');
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));
    expect(
      await within(form).findByText('Move it after: enter a whole number from 1 minute to 7 days.'),
    ).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/sla-policy')).toHaveLength(0);
    await user.clear(after);
    await user.type(after, '10');
    await user.selectOptions(to, 'team_care');
    await user.click(within(form).getByRole('button', { name: 'Save targets' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/sla-policy')[0]?.body).toMatchObject({
        enabled: true,
        overdue: {
          alertLeads: true,
          moveAfterMinutes: 10,
          moveTo: { kind: 'team', teamId: 'team_care' },
        },
      }),
    );
  });

  it('is not shown to people who cannot configure the inbox', async () => {
    const gateway = fakeGateway({ 'GET /v1/admin/brands': { json: { items: [brand] } } });
    const manager = owner.filter((p) => p !== 'inbox.manage');
    await mountStudio({ at: '/hours', permissions: manager, screen: <HoursPage /> });
    await screen.findByTestId('hours-form');
    expect(screen.queryByTestId('reply-targets')).toBeNull();
    expect(gateway.to('GET', '/v1/admin/brands/brd_1/sla-policy')).toHaveLength(0);
  });
});
