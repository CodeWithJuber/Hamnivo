// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, useContext } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { InboxConversation, InboxDetail } from '../src/lib/inbox';
import { ConversationPane } from '../src/pages/inbox/ConversationPane';
import { InboxPage } from '../src/pages/inbox/InboxPage';
import { type Answer, type Call, fakeGateway, mountStudio, SELF_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});
// Drafts the composer keeps in this browser must not carry over from one test to the next.
beforeEach(() => localStorage.clear());

const agent = presetPermissions('agent');
const NOW = new Date().toISOString();
const MESSAGES = '/v1/conversations/conv_1/messages';
const CLOSED =
  'WhatsApp only allows template messages now. You can reply again after the customer writes.';

/** In `ms` from now, as the gateway writes times. */
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

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
  customer: { displayName: 'Hana', identity: 'unknown', language: 'en' },
  lastMessage: { preview: 'Is the blue one in stock?', at: NOW, from: 'customer' },
  labels: [],
  snoozedUntil: null,
  ticket: null,
  priority: null,
  waitingSince: null,
  replyWindowClosesAt: null,
  unreadCount: 0,
  lastActivityAt: NOW,
  createdAt: NOW,
  ...patch,
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

/** One conversation open on its own, with its drafts and a send route. */
function pane(first: InboxDetail, send: (call: Call) => Answer = () => ({ status: 202 })) {
  let current = first;
  const gateway = fakeGateway({
    'GET /v1/inbox/conversations/conv_1': () => ({ json: current }),
    'GET /v1/inbox/conversations/conv_1/drafts': { json: { drafts: [], outgoing: [] } },
    [`POST ${MESSAGES}`]: (call) => {
      const answer = send(call);
      return 'problem' in answer || answer.status !== 202
        ? answer
        : { status: 202, json: { messageId: 'msg_1', status: 'accepted' } };
    },
  });
  return {
    gateway,
    /** What the gateway says about the conversation from now on. */
    set: (next: InboxDetail) => {
      current = next;
    },
    mount: () =>
      mountStudio({ at: '/inbox/conv_1', permissions: agent, screen: <ConversationPane /> }),
  };
}

const reply = () => screen.findByTestId('composer-public') as Promise<HTMLTextAreaElement>;
const sendButton = () => screen.getByTestId('send-reply') as HTMLButtonElement;
const assertive = () => document.querySelector('[data-slot="announcer-assertive"]')?.textContent;

describe('the composer says where a reply goes', () => {
  it('by email, on Telegram, and nothing extra for web chat', async () => {
    const email = pane(detail({ channel: 'email' }));
    const first = await email.mount();
    await reply();
    expect(screen.getByTestId('reply-channel').textContent).toBe('Your reply is sent by email.');
    first.unmount();

    const telegram = pane(detail({ channel: 'telegram' }));
    const second = await telegram.mount();
    await reply();
    expect(screen.getByTestId('reply-channel').textContent).toBe('Your reply is sent on Telegram.');
    // The conversation's channel badge names Telegram too.
    expect(screen.getAllByText('Telegram').length).toBeGreaterThan(0);
    second.unmount();

    pane(detail({ channel: 'chat' })).mount();
    await reply();
    expect(screen.queryByTestId('reply-channel')).toBeNull();
  });

  it('on WhatsApp with the window open: the line only, and the reply is sent', async () => {
    const { gateway, mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(20 * 3_600_000) }),
    );
    await mount();
    const field = await reply();
    expect(screen.getByTestId('reply-channel').textContent).toBe('Your reply is sent on WhatsApp.');
    expect(screen.queryByTestId('reply-window-left')).toBeNull();
    expect(screen.queryByTestId('reply-window-closed')).toBeNull();
    const user = userEvent.setup();
    await user.type(field, 'Yes, in all sizes.');
    await user.click(sendButton());
    await waitFor(() => expect(gateway.to('POST', MESSAGES)).toHaveLength(1));
    expect(gateway.to('POST', MESSAGES)[0]?.body).toMatchObject({
      text: 'Yes, in all sizes.',
      visibility: 'public',
    });
  });

  it('on WhatsApp in the last two hours: how many minutes are left', async () => {
    const { mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(45 * 60_000 - 5_000) }),
    );
    await mount();
    await reply();
    const left = screen.getByTestId('reply-window-left');
    expect(left.textContent).toBe('You can reply for another 45 minutes.');
    expect(left.querySelector('svg')).toBeTruthy();
    expect(sendButton().disabled).toBe(true); // nothing typed yet
    expect((await reply()).readOnly).toBe(false);
  });

  it('on WhatsApp after 24 hours: replies are off with a notice, notes still work', async () => {
    const { gateway, mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(-3_600_000) }),
    );
    await mount();
    const field = await reply();
    const notice = screen.getByTestId('reply-window-closed');
    expect(notice.textContent).toBe(CLOSED);
    // Said in words with an icon, not by colour alone; the field points to it.
    expect(notice.querySelector('svg')).toBeTruthy();
    expect(field.getAttribute('aria-describedby')).toContain('composer-window-closed');
    expect(field.readOnly).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(screen.queryByTestId('saved-replies')).toBeNull();
    expect(screen.queryByTestId('copilot')).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId('lane-internal'));
    expect(screen.queryByTestId('reply-window-closed')).toBeNull();
    const note = (await screen.findByTestId('composer-internal')) as HTMLTextAreaElement;
    expect(note.readOnly).toBe(false);
    await user.type(note, 'Customer went quiet.');
    await user.click(screen.getByTestId('add-note'));
    await waitFor(() => expect(gateway.to('POST', MESSAGES)).toHaveLength(1));
    expect(gateway.to('POST', MESSAGES)[0]?.body).toMatchObject({ visibility: 'internal' });
  });

  it('when the window closed while typing: the same notice, not a generic error', async () => {
    const harness = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(5 * 60_000) }),
      () => ({
        problem: { status: 409, code: 'CHANNEL_WINDOW_CLOSED' },
      }),
    );
    await harness.mount();
    const field = await reply();
    const user = userEvent.setup();
    await user.type(field, 'Are you still there?');
    // The gateway's clock says the window has just closed.
    harness.set(detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(-1_000) }));
    await user.click(sendButton());
    expect((await screen.findByTestId('reply-window-closed')).textContent).toBe(CLOSED);
    expect(screen.queryByTestId('action-error')).toBeNull();
    await waitFor(() => expect(assertive()).toBe(CLOSED));
    // Nothing was sent; the text stays for later.
    expect(field.value).toBe('Are you still there?');
    expect(field.readOnly).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(harness.gateway.to('POST', MESSAGES)).toHaveLength(1);
  });

  it('a refusal closes replies in that window, until the customer writes again', async () => {
    const harness = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(10 * 3_600_000) }),
      () => ({ problem: { status: 409, code: 'CHANNEL_WINDOW_CLOSED' } }),
    );
    const { client } = await harness.mount();
    const field = await reply();
    const user = userEvent.setup();
    await user.type(field, 'Hello again');
    await user.click(sendButton());
    expect((await screen.findByTestId('reply-window-closed')).textContent).toBe(CLOSED);
    expect(screen.queryByTestId('action-error')).toBeNull();

    // The customer writes again: a new window, and replies are back.
    harness.set(detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(24 * 3_600_000) }));
    await client.invalidateQueries();
    await waitFor(() => expect(screen.queryByTestId('reply-window-closed')).toBeNull());
    expect((await reply()).readOnly).toBe(false);
    expect(field.value).toBe('Hello again');
  });
});

/** The test router draws the page twice (layout and outlet); the inbox only once here. */
const Inside = createContext(false);
function Once({ children }: { children: ReactNode }) {
  return useContext(Inside) ? null : <Inside.Provider value>{children}</Inside.Provider>;
}

describe('Telegram in the inbox list', () => {
  it('is a channel to filter by, and its conversations say so', async () => {
    const gateway = fakeGateway({
      'GET /v1/inbox/conversations': {
        json: {
          items: [
            row({
              channel: 'telegram',
              customer: { displayName: 'Omar', identity: 'unknown', language: null },
            }),
          ],
          nextCursor: null,
          counts: { mine: 1, unassigned: 0, ai: 0, team: 0, tickets: 0, all: 1 },
        },
      },
    });
    const { router } = await mountStudio({
      at: '/inbox',
      permissions: agent,
      screen: (
        <Once>
          <InboxPage />
        </Once>
      ),
    });
    const [first] = await screen.findAllByTestId('inbox-row');
    expect(within(first as HTMLElement).getByText('Telegram')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Filters/ }));
    const channel = (await screen.findByLabelText('Channel')) as HTMLSelectElement;
    expect([...channel.options].map((option) => option.text)).toEqual([
      'All channels',
      'Website chat',
      'Email',
      'WhatsApp',
      'Telegram',
      'SMS',
      'Other channel',
    ]);
    await user.selectOptions(channel, 'telegram');
    await waitFor(() => expect(router.state.location.search).toEqual({ channel: 'telegram' }));
    await waitFor(() =>
      expect(
        gateway
          .to('GET', '/v1/inbox/conversations')
          .some((call) => call.query.channel === 'telegram'),
      ).toBe(true),
    );
  });
});
