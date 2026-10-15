// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createContext, type ReactNode, useContext } from 'react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import type { InboxConversation, InboxDetail, WhatsappTemplate } from '../src/lib/inbox';
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
  sla: null,
  aiDraftReady: false,
  offer: null,
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

/** One conversation open on its own, with its drafts, a send route and any other routes. */
function pane(
  first: InboxDetail,
  send: (call: Call) => Answer = () => ({ status: 202 }),
  more: Record<string, Answer | ((call: Call) => Answer)> = {},
) {
  let current = first;
  const gateway = fakeGateway({
    ...more,
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
const polite = () => document.querySelector('[data-slot="announcer-polite"]')?.textContent;

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
          counts: { mine: 1, unassigned: 0, overdue: 0, ai: 0, team: 0, tickets: 0, all: 1 },
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

const TEMPLATES = '/v1/conversations/conv_1/whatsapp-templates';
const template = (patch: Partial<WhatsappTemplate> = {}): WhatsappTemplate => ({
  name: 'order_ready',
  language: 'en_US',
  category: 'UTILITY',
  header: 'Order {{order}}',
  body: 'Hi {{customer_name}}, your order is ready at {{1}}.',
  footer: 'Noor Books',
  buttons: [{ type: 'copy_code', text: 'Copy code' }],
  variables: {
    header: ['order'],
    body: ['customer_name', '1'],
    buttons: [{ index: 0, type: 'copy_code', label: 'Copy code' }],
  },
  unsupported: null,
  ...patch,
});
const TEMPLATE_LIST = {
  items: [
    template({
      name: 'pending_one',
      body: 'Your parcel left the shop.',
      variables: { header: [], body: [], buttons: [] },
      unsupported: 'not_approved',
    }),
    template(),
    template({
      name: 'login_code',
      category: 'AUTHENTICATION',
      body: '{{1}} is your code.',
      unsupported: 'authentication',
    }),
    template({
      name: 'welcome_ar',
      language: 'ar',
      category: 'MARKETING',
      header: null,
      body: 'مرحبًا {{1}}',
      footer: null,
      buttons: [],
      variables: { header: [], body: ['1'], buttons: [] },
    }),
  ],
  windowOpen: false,
  windowClosesAt: inMs(-3_600_000),
  lastSyncedAt: inMs(-5 * 60_000),
};
const ticket = {
  number: 1042,
  reference: '#1042',
  state: 'open' as const,
  source: 'staff' as const,
  openedAt: NOW,
};

describe('WhatsApp templates in the composer (D14)', () => {
  it('after 24 hours: pick a template, fill it in, check the preview and send it', async () => {
    const { gateway, mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(-3_600_000), ticket }),
      undefined,
      { [`GET ${TEMPLATES}`]: { json: TEMPLATE_LIST } },
    );
    await mount();
    await reply();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Send a template' }));
    const dialog = await screen.findByTestId('template-dialog');
    expect(within(dialog).getByRole('heading', { name: 'Send a WhatsApp template' })).toBeTruthy();
    await within(dialog).findAllByTestId('template-option');

    // Grouped by language, ones that can be sent first, each with its category and text.
    const groups = within(dialog).getAllByRole('heading', { level: 3 });
    expect(groups.map((h) => h.textContent)).toEqual(['American English', 'Arabic']);
    const options = within(dialog).getAllByTestId('template-option');
    expect(options.map((o) => o.querySelector('bdi')?.textContent)).toEqual([
      'order_ready',
      'pending_one',
      'login_code',
      'welcome_ar',
    ]);
    expect(options[0]?.textContent).toContain('Utility');
    expect(options[0]?.textContent).toContain('your order is ready');
    expect(within(dialog).getByTestId('templates-synced').textContent).toBe(
      'Templates last updated 5 minutes ago. New templates appear here after Chatwoot syncs them from Meta.',
    );

    // One Meta has not approved, or a one-time code, says why and cannot be chosen.
    const pending = options[1] as HTMLElement;
    expect(pending.getAttribute('aria-disabled')).toBe('true');
    expect(within(pending).getByTestId('template-reason').textContent).toBe(
      'Waiting for Meta’s approval',
    );
    expect(within(options[2] as HTMLElement).getByTestId('template-reason').textContent).toBe(
      'One-time codes are sent by your own systems',
    );
    await user.click(pending);
    expect(within(dialog).queryByTestId('template-form')).toBeNull();

    // Search narrows the list.
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search templates' }), 'ready');
    expect(within(dialog).getAllByTestId('template-option')).toHaveLength(1);
    await user.click(within(dialog).getByTestId('template-option'));

    // Named values Studio knows are filled in; numbered ones are not.
    const order = within(dialog).getByLabelText('Header {{order}}') as HTMLInputElement;
    expect(order.value).toBe('1042');
    const name = within(dialog).getByLabelText('Message {{customer_name}}') as HTMLInputElement;
    expect(name.value).toBe('Hana');
    expect(within(dialog).getAllByText('Filled in from this conversation.')).toHaveLength(2);
    const where = within(dialog).getByLabelText('Message {{1}}') as HTMLInputElement;
    expect(where.value).toBe('');
    const code = within(dialog).getByLabelText('Button “Copy code”') as HTMLInputElement;
    expect(code.maxLength).toBe(15);
    expect(code.getAttribute('dir')).toBe('ltr');

    // The preview shows what is still empty, and Send says what is missing.
    expect(within(dialog).getByTestId('preview-header').textContent).toBe('Order 1042');
    expect(within(dialog).getByTestId('preview-body').textContent).toBe(
      'Hi Hana, your order is ready at {{1}}.',
    );
    expect(within(dialog).getByTestId('preview-unfilled').textContent).toBe('{{1}}');
    expect(within(dialog).getByTestId('preview-footer').textContent).toBe('Noor Books');
    const send = within(dialog).getByTestId('send-template');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(within(dialog).getByText('Fill in 2 more values to send.')).toBeTruthy();
    await user.click(send);
    expect(gateway.to('POST', MESSAGES)).toHaveLength(0);

    await user.type(where, 'the Dubai Mall');
    await user.type(code, 'SAVE10');
    expect(within(dialog).getByTestId('preview-body').textContent).toBe(
      'Hi Hana, your order is ready at the Dubai Mall.',
    );
    expect(within(dialog).queryByTestId('preview-unfilled')).toBeNull();
    // The button stands on its own again (no reason next to it).
    const ready = within(dialog).getByTestId('send-template');
    expect(ready.getAttribute('aria-disabled')).toBeNull();
    await user.click(ready);
    await waitFor(() => expect(gateway.to('POST', MESSAGES)).toHaveLength(1));
    const body = gateway.to('POST', MESSAGES)[0]?.body;
    expect(body).toEqual({
      clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      template: {
        name: 'order_ready',
        language: 'en_US',
        values: {
          header: { order: '1042' },
          body: { customer_name: 'Hana', '1': 'the Dubai Mall' },
          buttons: { '0': 'SAVE10' },
        },
      },
      visibility: 'public',
      clearDraft: false,
      expectedEpoch: 3,
    });
    await waitFor(() => expect(screen.queryByTestId('template-dialog')).toBeNull());
    await waitFor(() => expect(polite()).toBe('Template sent.'));
  });

  it('shows the gateway’s reasons next to the values, and keeps the dialog open', async () => {
    const { gateway, mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(-3_600_000) }),
      () => ({
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'template.values.body.1', message: 'This template has no such value.' }],
        },
      }),
      { [`GET ${TEMPLATES}`]: { json: TEMPLATE_LIST } },
    );
    await mount();
    await reply();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('template-open'));
    const dialog = await screen.findByTestId('template-dialog');
    const options = await within(dialog).findAllByTestId('template-option');
    await user.click(options[3] as HTMLElement);
    const value = within(dialog).getByLabelText('Message {{1}}') as HTMLInputElement;
    // Typed Arabic reads right to left on its own.
    await user.type(value, 'هناء');
    expect(value.getAttribute('dir')).toBe('auto');
    await user.click(within(dialog).getByTestId('send-template'));
    await waitFor(() => expect(value.getAttribute('aria-invalid')).toBe('true'));
    expect(value.getAttribute('aria-describedby')).toContain('template-body-1-error');
    expect(document.getElementById('template-body-1-error')?.textContent).toBe(
      'This template has no such value.',
    );
    expect(document.activeElement).toBe(value);
    expect(screen.getByTestId('template-dialog')).toBeTruthy();
    expect(gateway.to('POST', MESSAGES)).toHaveLength(1);

    // Back to the list keeps the dialog open.
    await user.click(within(dialog).getByTestId('template-back'));
    expect(await within(dialog).findAllByTestId('template-option')).toHaveLength(4);
  });

  it('while the window is open: a Template button next to Saved replies', async () => {
    const { mount } = pane(
      detail({ channel: 'whatsapp', replyWindowClosesAt: inMs(20 * 3_600_000) }),
      undefined,
      {
        [`GET ${TEMPLATES}`]: {
          json: { items: [], windowOpen: true, windowClosesAt: null, lastSyncedAt: null },
        },
      },
    );
    await mount();
    await reply();
    expect(screen.getByTestId('saved-replies')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Template' }));
    const empty = await screen.findByTestId('templates-empty');
    expect(empty.textContent).toContain('No approved templates yet');
    const guide = within(empty).getByRole('link', { name: /How template messages work/ });
    expect(guide.getAttribute('href')).toMatch(/whatsapp.*#template-messages$/);
    expect(screen.getByTestId('templates-synced').textContent).toBe(
      'New templates appear here after Chatwoot syncs them from Meta.',
    );
  });

  it('only on WhatsApp, and not for someone who may not reply', async () => {
    const chat = pane(detail({ channel: 'chat' }));
    const first = await chat.mount();
    await reply();
    expect(screen.queryByTestId('template-button')).toBeNull();
    first.unmount();

    pane(
      detail({
        channel: 'whatsapp',
        replyWindowClosesAt: inMs(20 * 3_600_000),
        permissions: { ...detail().permissions, reply: false },
      }),
    ).mount();
    await screen.findByTestId('composer-internal');
    expect(screen.queryByTestId('template-button')).toBeNull();
    expect(screen.queryByTestId('template-open')).toBeNull();
  });
});
