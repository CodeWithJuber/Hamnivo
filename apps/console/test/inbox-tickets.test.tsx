// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, useContext } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { InboxConversation, InboxDetail } from '../src/lib/inbox';
import { ConversationPane } from '../src/pages/inbox/ConversationPane';
import { InboxPage } from '../src/pages/inbox/InboxPage';
import { type Answer, type Call, fakeGateway, mountStudio, SELF_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');

/**
 * The test router draws the screen for the layout and again for the page in its outlet; the
 * inbox has an outlet of its own (for the open conversation), so it is drawn once only here.
 */
const Inside = createContext(false);
function Once({ children }: { children: ReactNode }) {
  return useContext(Inside) ? null : <Inside.Provider value>{children}</Inside.Provider>;
}
const inbox = (
  <Once>
    <InboxPage />
  </Once>
);
const NOW = '2026-10-01T09:00:00.000Z';

const row = (patch: Partial<InboxConversation> = {}): InboxConversation => ({
  id: 'conv_1',
  brand: { id: 'brd_1', name: 'Noor Books' },
  inboxId: 'inb_1',
  channel: 'chat',
  status: 'open',
  customerStatus: 'open',
  ownerMode: 'HUMAN_ACTIVE',
  ownershipEpoch: 3,
  owner: { kind: 'staff', staffMemberId: SELF_ID, displayName: 'Omar Agent' },
  ownerReason: 'staff_takeover',
  ownerChangedAt: NOW,
  team: null,
  customer: { displayName: 'Aisha Khan', identity: 'anonymous', language: 'en' },
  lastMessage: { preview: 'Where is my order?', at: NOW, from: 'customer' },
  labels: [],
  snoozedUntil: null,
  ticket: null,
  priority: null,
  waitingSince: null,
  sla: null,
  replyWindowClosesAt: null,
  unreadCount: 0,
  lastActivityAt: NOW,
  createdAt: NOW,
  ...patch,
});

const ticket = (state: 'open' | 'pending' | 'closed' = 'open') => ({
  number: 1042,
  reference: '#1042',
  state,
  source: 'offline_form' as const,
  openedAt: NOW,
});

const detail = (patch: Partial<InboxDetail> = {}): InboxDetail => ({
  ...row(),
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
  ...patch,
});

const listPage = (items: InboxConversation[]) => ({
  items,
  nextCursor: null,
  counts: { mine: 2, unassigned: 0, overdue: 0, ai: 0, team: 0, tickets: 3, all: 2 },
});

describe('the tickets queue', () => {
  it('has a pill with its count, and its state and priority filters go in the address', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': {
        json: listPage([
          row({
            id: 'conv_1',
            ticket: ticket('pending'),
            priority: 'high',
            status: 'snoozed',
          }),
          row({
            id: 'conv_2',
            priority: 'urgent',
            customer: { displayName: 'Bilal', identity: 'anonymous', language: null },
          }),
        ]),
      },
    });
    const { router } = await mountStudio({
      at: '/inbox',
      permissions: agent,
      screen: inbox,
    });
    const queues = screen.getByRole('navigation', { name: 'Queues' });
    const pill = await within(queues).findByRole('link', { name: /Tickets/ });
    await waitFor(() => expect(pill.textContent).toBe('Tickets3'));

    // A ticket's row says its reference and where it stands; any conversation its priority.
    const [first, second] = await screen.findAllByTestId('inbox-row');
    expect(first?.textContent).toContain('#1042');
    expect(within(first as HTMLElement).getByText('Ticket #1042')).toBeTruthy();
    expect(first?.textContent).toContain('Waiting for the customer');
    expect(first?.textContent).toContain('High priority');
    // Its state says it waits, so the snoozed badge does not say it again.
    expect(first?.querySelector('[data-status="snoozed"]')).toBeNull();
    expect(second?.textContent).toContain('Urgent');
    expect(second?.querySelector('[data-priority="urgent"]')?.querySelector('svg')).toBeTruthy();
    expect(screen.queryByTestId('ticket-filters')).toBeNull();

    const user = userEvent.setup();
    await user.click(pill);
    await waitFor(() => expect(router.state.location.search).toEqual({ queue: 'tickets' }));
    const asked = (check: (call: Call) => boolean) =>
      waitFor(() =>
        expect(gateway.to('GET', '/v1/inbox/conversations').some((call) => check(call))).toBe(true),
      );
    // Every ticket, whatever its status: a closed ticket is still a ticket.
    await asked((call) => call.query.queue === 'tickets' && call.query.status === 'all');

    const filters = await screen.findByTestId('ticket-filters');
    const states = within(filters).getByRole('navigation', { name: 'Ticket state' });
    expect(
      within(states)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Open', 'Pending', 'Closed', 'All']);
    expect(within(states).getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await user.click(within(states).getByRole('link', { name: 'Pending' }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ queue: 'tickets', ticketState: 'pending' }),
    );
    await asked((call) => call.query.ticketState === 'pending');

    await user.selectOptions(within(filters).getByLabelText('Priority'), 'urgent');
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        queue: 'tickets',
        ticketState: 'pending',
        priority: 'urgent',
      }),
    );
    await asked((call) => call.query.ticketState === 'pending' && call.query.priority === 'urgent');
    expect(
      within(filters).getByRole('link', { name: 'How tickets work' }).getAttribute('target'),
    ).toBe('_blank');

    // Another queue leaves the ticket filters behind.
    await user.click(within(queues).getByRole('link', { name: /Mine/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({ queue: 'mine' }));
    expect(screen.queryByTestId('ticket-filters')).toBeNull();
  });

  it('offers to see every ticket when none match the state and priority', async () => {
    fakeGateway({ 'GET /v1/inbox/conversations': { json: listPage([]) } });
    const { router } = await mountStudio({
      at: '/inbox?queue=tickets&ticketState=closed&priority=low',
      permissions: agent,
      screen: inbox,
    });
    expect(await screen.findByText('No tickets match')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'See all tickets' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ queue: 'tickets' }));
  });
});

type Routes = Parameters<typeof fakeGateway>[0];

/**
 * One conversation open on its own. The gateway answers the conversation with what was last set
 * (a change answers with the conversation as it is after it); what its other parts ask for is
 * left unplanned (404), as it does not matter here.
 */
const pane = (
  first: InboxDetail,
  routes: (set: (next: InboxDetail) => Answer) => Routes = () => ({}),
) => {
  let current = first;
  const set = (next: InboxDetail): Answer => {
    current = next;
    return { json: next };
  };
  const gateway = fakeGateway({
    'GET /v1/inbox/conversations/conv_1': () => ({ json: current }),
    ...routes(set),
  });
  const mount = () =>
    mountStudio({ at: '/inbox/conv_1', permissions: agent, screen: <ConversationPane /> });
  return { gateway, mount };
};

/** Opens the conversation's More menu by keyboard and picks "Make this a ticket". */
const openMakeTicket = async (user: ReturnType<typeof userEvent.setup>) => {
  (await screen.findByRole('button', { name: 'More actions' })).focus();
  await user.keyboard('{Enter}');
  await user.click(await screen.findByRole('menuitem', { name: 'Make this a ticket' }));
  return screen.findByTestId('make-ticket-dialog');
};

describe('a ticket above its conversation', () => {
  it('sets Pending and Closed through the status, and the priority, with the owner it saw', async () => {
    const { gateway, mount } = pane(detail({ ticket: ticket('open') }), (set) => ({
      'POST /v1/inbox/conversations/conv_1/status': (call) => {
        const status = (call.body as { status: InboxDetail['status'] }).status;
        const state = status === 'snoozed' ? 'pending' : status === 'resolved' ? 'closed' : 'open';
        return set(detail({ ticket: ticket(state), status }));
      },
      'POST /v1/inbox/conversations/conv_1/priority': (call) =>
        set(
          detail({
            ticket: ticket('closed'),
            status: 'resolved',
            priority: (call.body as { priority: InboxDetail['priority'] }).priority,
          }),
        ),
    }));
    await mount();
    const bar = () => screen.getByTestId('ticket-bar');
    await screen.findByTestId('ticket-bar');
    expect(within(bar()).getByRole('heading', { name: 'Ticket #1042' })).toBeTruthy();
    expect(bar().textContent).toContain('Left with the contact form');
    // The ticket's state takes the place of Snooze and Resolve.
    expect(screen.queryByTestId('resolve')).toBeNull();
    expect(screen.queryByTestId('snooze-menu')).toBeNull();
    const radio = (name: string) =>
      within(within(bar()).getByRole('radiogroup', { name: 'Ticket state' })).getByRole('radio', {
        name,
      });
    expect(radio('Open').getAttribute('aria-checked')).toBe('true');

    const user = userEvent.setup();
    const posts = (path: string) => gateway.to('POST', `/v1/inbox/conversations/conv_1/${path}`);
    await user.click(radio('Pending'));
    // Pending waits for the customer: snoozed with no time, until they write.
    await waitFor(() =>
      expect(posts('status')[0]?.body).toEqual({ status: 'snoozed', expectedEpoch: 3 }),
    );
    await waitFor(() => expect(radio('Pending').getAttribute('aria-checked')).toBe('true'));
    expect(bar().textContent).toContain('It opens again when they write.');
    await user.click(radio('Closed'));
    await waitFor(() =>
      expect(posts('status')[1]?.body).toEqual({ status: 'resolved', expectedEpoch: 3 }),
    );
    await waitFor(() => expect(radio('Closed').getAttribute('aria-checked')).toBe('true'));
    await user.click(radio('Open'));
    await waitFor(() =>
      expect(posts('status')[2]?.body).toEqual({ status: 'open', expectedEpoch: 3 }),
    );

    const priority = () => within(bar()).getByLabelText<HTMLSelectElement>('Priority');
    await user.selectOptions(priority(), 'high');
    await waitFor(() =>
      expect(posts('priority')[0]?.body).toEqual({ priority: 'high', expectedEpoch: 3 }),
    );
    await waitFor(() => expect(priority().value).toBe('high'));
    await user.selectOptions(priority(), '');
    await waitFor(() =>
      expect(posts('priority')[1]?.body).toEqual({ priority: null, expectedEpoch: 3 }),
    );
  });

  it('says why the state and priority cannot be changed without the permission', async () => {
    const { mount } = pane(
      detail({ ticket: ticket('open'), permissions: { ...detail().permissions, status: false } }),
    );
    await mount();
    const bar = await screen.findByTestId('ticket-bar');
    const reason = within(bar).getByTestId('ticket-reason');
    expect(reason.textContent).toBe(
      'Your role can’t change the state or priority of conversations.',
    );
    for (const radio of within(bar).getAllByRole('radio')) {
      expect((radio as HTMLButtonElement).disabled).toBe(true);
    }
    const priority = within(bar).getByLabelText<HTMLSelectElement>('Priority');
    expect(priority.disabled).toBe(true);
    expect(priority.getAttribute('aria-describedby')).toBe(reason.id);
    expect(
      within(bar)
        .getByRole('radiogroup', { name: 'Ticket state' })
        .getAttribute('aria-describedby'),
    ).toBe(reason.id);
  });
});

describe('making a conversation a ticket', () => {
  it('asks for an optional priority, then makes the ticket with the owner it saw', async () => {
    const { gateway, mount } = pane(detail(), (set) => ({
      'POST /v1/inbox/conversations/conv_1/ticket': (call) =>
        set(
          detail({
            ticket: { ...ticket('open'), source: 'staff' },
            priority: (call.body as { priority?: InboxDetail['priority'] }).priority ?? null,
          }),
        ),
    }));
    await mount();
    const user = userEvent.setup();
    const dialog = await openMakeTicket(user);
    expect(
      within(dialog).getByRole('heading', { name: 'Make this conversation a ticket' }),
    ).toBeTruthy();
    await user.selectOptions(within(dialog).getByLabelText(/Priority/), 'urgent');
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/inbox/conversations/conv_1/ticket')[0]?.body).toEqual({
        priority: 'urgent',
        expectedEpoch: 3,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('make-ticket-dialog')).toBeNull());
    // The conversation is a ticket now: its state and priority are above it.
    const bar = await screen.findByTestId('ticket-bar');
    expect(bar.textContent).toContain('Made a ticket by your team');
    expect(within(bar).getByLabelText<HTMLSelectElement>('Priority').value).toBe('urgent');
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('sends no priority when none is chosen', async () => {
    const { gateway, mount } = pane(detail(), (set) => ({
      'POST /v1/inbox/conversations/conv_1/ticket': () => set(detail({ ticket: ticket('open') })),
    }));
    await mount();
    const user = userEvent.setup();
    const dialog = await openMakeTicket(user);
    await user.click(within(dialog).getByRole('button', { name: 'Create ticket' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/inbox/conversations/conv_1/ticket')[0]?.body).toEqual({
        expectedEpoch: 3,
      }),
    );
  });

  it('says why it cannot make a ticket without the permission, and sends nothing', async () => {
    const { gateway, mount } = pane(
      detail({ permissions: { ...detail().permissions, status: false } }),
    );
    await mount();
    const user = userEvent.setup();
    const dialog = await openMakeTicket(user);
    const create = within(dialog).getByRole('button', { name: 'Create ticket' });
    expect(create.getAttribute('aria-disabled')).toBe('true');
    expect(dialog.textContent).toContain('Your role can’t change the state or priority');
    await user.click(create);
    expect(gateway.writes().filter((call) => call.path.endsWith('/ticket'))).toEqual([]);
  });
});
