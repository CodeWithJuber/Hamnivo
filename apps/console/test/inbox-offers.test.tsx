// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, useContext } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { InboxConversation } from '../src/lib/inbox';
import { formatCountdown } from '../src/lib/offers';
import { InboxPage } from '../src/pages/inbox/InboxPage';
import { fakeGateway, mountStudio, SELF_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const agent = presetPermissions('agent');

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
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

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

const counts = { mine: 0, unassigned: 1, overdue: 0, ai: 0, team: 0, tickets: 0, all: 1 };

const offerFor = (staffMemberId: string, displayName: string, seconds = 42) => ({
  id: 'ofr_1',
  staffMemberId,
  displayName,
  expiresAt: inSeconds(seconds),
  round: 1,
});

describe('chats offered to me (HNV-10-03)', () => {
  it('shows each offer with the time left, and accepting opens the chat as mine', async () => {
    const offered = row({
      id: 'conv_7',
      offer: offerFor(SELF_ID, 'Omar Agent'),
      team: { id: 'team_1', name: 'Care' },
    });
    let mine = [offered];
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [offered], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': { json: { items: [], total: 0 } },
      'GET /v1/inbox/offers': () => ({ json: { items: mine } }),
      'POST /v1/inbox/offers/ofr_1/accept': () => {
        mine = [];
        return { json: { conversationId: 'conv_7', state: 'accepted' } };
      },
    });
    const { router } = await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const section = await screen.findByTestId('offers-section');
    expect(within(section).getByRole('heading', { name: 'Offered to you' })).toBeTruthy();
    const card = within(section).getByTestId('offer-card');
    expect(card.textContent).toContain('Aisha Khan');
    expect(card.textContent).toContain('Where is my order?');
    expect(card.textContent).toContain('Offer 1 of 3');
    expect(card.textContent).toContain('Team: Care');
    const countdown = within(card).getByTestId('offer-countdown');
    expect(countdown.textContent).toMatch(/^0:4[0-2] left$/);
    expect(countdown.getAttribute('aria-label')).toMatch(/^Time left to accept: 0:4[0-2]$/);
    // The row in the queue says it is offered to me.
    const badge = within(screen.getByTestId('inbox-row')).getByTestId('offer-badge');
    expect(badge.textContent).toMatch(/^Offered to you · 0:4[0-2]$/);

    await userEvent
      .setup()
      .click(within(card).getByRole('button', { name: 'Accept the chat with Aisha Khan' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/inbox/offers/ofr_1/accept')).toHaveLength(1),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox/conv_7'));
  });

  it('asks why before declining, and sends the reason and note', async () => {
    const offered = row({ id: 'conv_7', offer: offerFor(SELF_ID, 'Omar Agent') });
    let mine = [offered];
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': { json: { items: [], total: 0 } },
      'GET /v1/inbox/offers': () => ({ json: { items: mine } }),
      'POST /v1/inbox/offers/ofr_1/decline': () => {
        mine = [];
        return { json: { conversationId: 'conv_7', state: 'declined' } };
      },
    });
    await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const card = await screen.findByTestId('offer-card');
    const user = userEvent.setup();
    await user.click(
      within(card).getByRole('button', { name: 'Decline the chat with Aisha Khan' }),
    );
    const dialog = await screen.findByTestId('decline-offer-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Decline chat' }));
    expect(dialog.textContent).toContain('Choose a reason.');
    expect(gateway.to('POST', '/v1/inbox/offers/ofr_1/decline')).toHaveLength(0);
    await user.click(within(dialog).getByRole('radio', { name: /I am going offline/ }));
    expect(dialog.textContent).toContain('Your status becomes Away');
    await user.type(within(dialog).getByLabelText(/Note/), 'Prayer break.');
    await user.click(within(dialog).getByRole('button', { name: 'Decline chat' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/inbox/offers/ofr_1/decline')[0]?.body).toEqual({
        reason: 'going_offline',
        note: 'Prayer break.',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('offers-section')).toBeNull());
  });

  it('says who has the chat when the offer closed before accepting', async () => {
    let mine = [row({ id: 'conv_7', offer: offerFor(SELF_ID, 'Omar Agent') })];
    fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': { json: { items: [], total: 0 } },
      'GET /v1/inbox/offers': () => ({ json: { items: mine } }),
      'POST /v1/inbox/offers/ofr_1/accept': () => {
        mine = [];
        return {
          problem: {
            status: 409,
            code: 'OFFER_CLOSED',
            currentOwner: { kind: 'staff', displayName: 'Rayan Lead', ownershipEpoch: 4 },
          },
        };
      },
    });
    await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const card = await screen.findByTestId('offer-card');
    await userEvent.setup().click(within(card).getByTestId('offer-accept'));
    const closed = await screen.findByTestId('offer-closed');
    expect(closed.getAttribute('role')).toBe('alert');
    expect(closed.textContent).toBe('Rayan Lead already took this conversation.');
  });

  it('shows colleagues whom a waiting chat is offered to, and they can still claim it', async () => {
    const offered = row({ id: 'conv_7', offer: offerFor('staff_amina', 'Amina') });
    fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [offered], nextCursor: null, counts } },
      'GET /v1/inbox/urgent': { json: { items: [], total: 0 } },
      'GET /v1/inbox/offers': { json: { items: [] } },
    });
    await mountStudio({ at: '/inbox', permissions: agent, screen: inbox });
    const [listed] = await screen.findAllByTestId('inbox-row');
    const badge = within(listed as HTMLElement).getByTestId('offer-badge');
    expect(badge.textContent).toMatch(/^Offered to Amina · 0:4[0-2]$/);
    expect(screen.queryByTestId('offers-section')).toBeNull();
  });

  it('is not asked for by people who cannot take conversations', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': { json: { items: [row()], nextCursor: null, counts } },
    });
    const viewer = agent.filter((p) => p !== 'conversations.takeover');
    await mountStudio({ at: '/inbox', permissions: viewer, screen: inbox });
    await screen.findAllByTestId('inbox-row');
    expect(screen.queryByTestId('offers-section')).toBeNull();
    expect(gateway.to('GET', '/v1/inbox/offers')).toHaveLength(0);
  });
});

describe('the countdown', () => {
  it('reads minutes and seconds', () => {
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(42)).toBe('0:42');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});
