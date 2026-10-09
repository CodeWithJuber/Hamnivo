// @vitest-environment jsdom
import * as contracts from '@hamnivo/contracts';
import { CHANNEL_CAPABILITIES } from '@hamnivo/domain';
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import {
  type ChannelInbox,
  channelKeys,
  connectTelegramBody,
  connectWhatsappBody,
  emptyTelegramDraft,
  emptyWhatsappDraft,
  invalidTelegramFields,
  invalidWhatsappFields,
  normalisePhone,
  REPLY_WINDOW_SOON_MS,
  replyWindow,
  type TelegramDraft,
  WHATSAPP_REPLY_WINDOW_HOURS,
  type WhatsappDraft,
  whatsappStepOf,
} from '../src/lib/channels';
import { CHANNELS } from '../src/lib/inbox';
import { keys } from '../src/lib/queries';
import type { Team } from '../src/lib/types';
import { ChannelsPage } from '../src/pages/channels/ChannelsPage';
import { BOTFATHER_GUIDE_URL, META_GUIDE_URL } from '../src/pages/channels/MessagingDialogs';
import { type Answer, type Call, fakeGateway, mountStudio, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-09T09:00:00.000Z';
const LIST = '/v1/admin/brands/brd_1/channels';
const WHATSAPP = `${LIST}/whatsapp`;
const TELEGRAM = `${LIST}/telegram`;
const SETUP = '/v1/admin/channels/inb_wa/whatsapp';
const TOKEN = 'EAAG-permanent-system-user-token';
const BOT_TOKEN = '1234567:AAH-test-token-abcdefghijklmnop';
const SET_UP = {
  callbackUrl: 'https://chatwoot.example/webhooks/whatsapp/+971501234567',
  verifyToken: 'verify-1234567890abcdef',
};

const brand = {
  id: 'brd_1',
  workspaceId: 'wsp_1',
  name: 'Noor Books',
  widgetId: 'wid_1',
  allowedOrigins: ['https://noor.example'],
  businessHours: null,
  status: 'active',
  createdAt: NOW,
};
const workspace = {
  id: 'wsp_1',
  name: 'Main',
  slug: 'main',
  status: 'active',
  brands: [{ id: 'brd_1', name: 'Noor Books', status: 'active' }],
};
const TEAMS = [
  { id: 'team_billing', name: 'Billing', workspaceId: 'wsp_1', status: 'active', members: [] },
] as unknown as Team[];

const channel = (overrides: Partial<ChannelInbox> = {}): ChannelInbox =>
  ({
    id: 'inb_wa',
    brandId: 'brd_1',
    kind: 'whatsapp',
    name: 'Shop WhatsApp',
    address: '+971501234567',
    status: 'connected',
    problem: null,
    aiAnswers: false,
    defaultTeamId: null,
    conversationsThisWeek: 0,
    lastEventAt: null,
    pausedAt: null,
    createdAt: NOW,
    ...overrides,
  }) as ChannelInbox;

const refused = (path: string, message: string): Answer => ({
  problem: { status: 422, code: 'VALIDATION_FAILED', fields: [{ path, message }] },
});

/** A gateway with the brand's channels, Connect WhatsApp, Meta set-up and Connect Telegram. */
function messagingGateway(
  start: ChannelInbox[],
  options: {
    whatsapp?: (call: Call) => Answer | undefined;
    telegram?: (call: Call) => Answer | undefined;
    setup?: () => Answer;
  } = {},
) {
  let items = [...start];
  return fakeGateway({
    [`GET ${LIST}`]: () => ({ json: { items } }),
    [`POST ${WHATSAPP}`]: (call) => {
      const special = options.whatsapp?.(call);
      if (special) return special;
      const body = call.body as { name: string; phoneNumber: string; aiAnswers: boolean };
      const added = channel({
        name: body.name,
        address: body.phoneNumber,
        aiAnswers: body.aiAnswers,
      });
      items = [...items, added];
      return { status: 201, json: { channel: added, setup: SET_UP } };
    },
    [`GET ${SETUP}`]: () => options.setup?.() ?? { json: SET_UP },
    [`POST ${TELEGRAM}`]: (call) => {
      const special = options.telegram?.(call);
      if (special) return special;
      const body = call.body as { name: string };
      const added = channel({
        id: 'inb_tg' as never,
        kind: 'telegram',
        name: body.name,
        address: '@noor_books_bot',
      });
      items = [...items, added];
      return { status: 201, json: added };
    },
  });
}

const seed = (items: ChannelInbox[]) => (client: QueryClient) => {
  client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
  client.setQueryData([TENANT_ID, ...keys.workspaces], { items: [workspace] });
  client.setQueryData([TENANT_ID, ...accessKeys.teams], { items: TEAMS });
  client.setQueryData([TENANT_ID, ...channelKeys.list('brd_1')], { items });
};

const page = (items: ChannelInbox[]) =>
  mountStudio({
    at: '/channels?brand=brd_1',
    permissions: owner,
    screen: <ChannelsPage />,
    seed: seed(items),
  });

const announced = () => document.querySelector('[data-slot="announcer-polite"]')?.textContent;
const waDialog = () => within(screen.getByTestId('connect-whatsapp-dialog'));
const tgDialog = () => within(screen.getByTestId('connect-telegram-dialog'));
const waStep = () => screen.getByTestId('whatsapp-step').textContent;

/** Fills the first step of Connect WhatsApp. */
async function fillNumber(user: UserEvent, token = TOKEN) {
  await user.type(waDialog().getByLabelText('Business phone number'), '+971 50 123 4567');
  await user.type(waDialog().getByLabelText('Phone number ID'), '1098765');
  await user.type(waDialog().getByLabelText('WhatsApp Business Account ID'), '2234567');
  await user.type(waDialog().getByLabelText('Access token'), token);
}

describe('WhatsApp and Telegram helpers', () => {
  const whatsapp: WhatsappDraft = {
    ...emptyWhatsappDraft('WhatsApp'),
    phoneNumber: '+971 50-123 4567',
    phoneNumberId: '1098765',
    businessAccountId: '2234567',
    accessToken: TOKEN,
  };

  it('checks WhatsApp fields exactly as the contract does', () => {
    const variants: Array<[string, Partial<WhatsappDraft>]> = [
      ['ok', {}],
      ['blank name', { name: '  ' }],
      ['long name', { name: 'x'.repeat(101) }],
      ['no plus', { phoneNumber: '971501234567' }],
      ['leading zero', { phoneNumber: '+0501234567' }],
      ['too short', { phoneNumber: '+12345' }],
      ['too long', { phoneNumber: '+1234567890123456' }],
      ['letters', { phoneNumber: '+97150abc4567' }],
      ['brackets', { phoneNumber: '+1 (415) 555-0100' }],
      ['id letters', { phoneNumberId: '10987a5' }],
      ['id short', { phoneNumberId: '1234' }],
      ['id long', { businessAccountId: '1'.repeat(31) }],
      ['id spaces around', { businessAccountId: ' 2234567 ' }],
      ['short token', { accessToken: 'x'.repeat(19) }],
      ['token padded', { accessToken: `  ${'x'.repeat(19)}  ` }],
      ['long token', { accessToken: 'x'.repeat(1001) }],
    ];
    for (const [label, change] of variants) {
      const draft = { ...whatsapp, ...change };
      const parsed = contracts.ConnectWhatsappRequest.safeParse(connectWhatsappBody(draft));
      const theirs = parsed.success
        ? []
        : [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      expect(invalidWhatsappFields(draft).sort(), label).toEqual(theirs.sort());
    }
  });

  it('checks Telegram fields exactly as the contract does', () => {
    const telegram: TelegramDraft = { ...emptyTelegramDraft('Telegram'), botToken: BOT_TOKEN };
    const variants: Array<[string, Partial<TelegramDraft>]> = [
      ['ok', {}],
      ['blank name', { name: '' }],
      ['no colon', { botToken: '1234567AAH-test-token-abcdefghijklmnop' }],
      ['short id', { botToken: '12:AAH-test-token-abcdefghijklmnop' }],
      ['short secret', { botToken: '1234567:short' }],
      ['space inside', { botToken: '1234567:AAH test-token-abcdefghijklmnop' }],
      ['spaces around', { botToken: `  ${BOT_TOKEN} ` }],
      ['not a token', { botToken: 'not-a-token' }],
    ];
    for (const [label, change] of variants) {
      const draft = { ...telegram, ...change };
      const parsed = contracts.ConnectTelegramRequest.safeParse(connectTelegramBody(draft));
      const theirs = parsed.success
        ? []
        : [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      expect(invalidTelegramFields(draft).sort(), label).toEqual(theirs.sort());
    }
  });

  it('sends the number without spaces or dashes, trimmed ids and token, and no team as null', () => {
    expect(normalisePhone(' +971 (50) 123-4567 ')).toBe('+971501234567');
    expect(connectWhatsappBody({ ...whatsapp, phoneNumberId: ' 1098765 ' })).toEqual({
      name: 'WhatsApp',
      phoneNumber: '+971501234567',
      phoneNumberId: '1098765',
      businessAccountId: '2234567',
      accessToken: TOKEN,
      aiAnswers: false,
      defaultTeamId: null,
    });
    expect(
      connectTelegramBody({
        ...emptyTelegramDraft(' Shop bot '),
        botToken: ` ${BOT_TOKEN}`,
        aiAnswers: true,
        defaultTeamId: 'team_billing',
      }),
    ).toEqual({
      name: 'Shop bot',
      botToken: BOT_TOKEN,
      aiAnswers: true,
      defaultTeamId: 'team_billing',
    });
  });

  it('knows which step holds a field the gateway names', () => {
    expect(
      ['name', 'phoneNumber', 'accessToken', 'defaultTeamId', 'provider_config'].map(
        whatsappStepOf,
      ),
    ).toEqual([1, 1, 1, 2, null]);
  });

  it('keeps the reply window and the inbox channels as the contracts and the domain have them', () => {
    expect(WHATSAPP_REPLY_WINDOW_HOURS).toBe(CHANNEL_CAPABILITIES.whatsapp.replyWindowHours);
    expect([...CHANNELS]).toEqual(contracts.InboxChannel.options);
    expect(contracts.ErrorCode.options).toContain('CHANNEL_WINDOW_CLOSED');
  });

  it('says whether a reply can still go out, counting the minutes in the last two hours', () => {
    const now = Date.parse(NOW);
    const at = (ms: number) => new Date(now + ms).toISOString();
    expect(replyWindow(null, now)).toEqual({ state: 'open' });
    expect(replyWindow(at(REPLY_WINDOW_SOON_MS + 60_000), now)).toEqual({ state: 'open' });
    expect(replyWindow(at(REPLY_WINDOW_SOON_MS), now)).toEqual({ state: 'closing', minutes: 120 });
    expect(replyWindow(at(30_500), now)).toEqual({ state: 'closing', minutes: 1 });
    expect(replyWindow(at(0), now)).toEqual({ state: 'closed' });
    expect(replyWindow(at(-3_600_000), now)).toEqual({ state: 'closed' });
  });
});

describe('Connect WhatsApp', () => {
  it('walks the number and answering, then shows Meta’s webhook set-up with Copy', async () => {
    const gateway = messagingGateway([]);
    await page([]);
    const user = userEvent.setup();
    const empty = within(screen.getByTestId('channels-empty'));
    expect(
      empty.getByText(
        'Connect your support email, a WhatsApp Business number or a Telegram bot here. Channels added in Chatwoot appear when you check for new channels.',
      ),
    ).toBeTruthy();
    expect(empty.getByRole('button', { name: 'Connect email' })).toBeTruthy();
    expect(empty.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy();
    await user.click(empty.getByRole('button', { name: 'Connect WhatsApp' }));
    await screen.findByRole('dialog', { name: 'Connect WhatsApp' });

    // Step 1: the number, with where to find it.
    expect(waStep()).toBe('Step 1 of 3');
    expect(waDialog().getByRole('heading', { name: 'Your number' })).toBeTruthy();
    const help = within(waDialog().getByTestId('whatsapp-help'));
    expect(
      help.getByText(
        'Find these in Meta’s WhatsApp Manager → API setup. Use a permanent access token from a system user.',
      ),
    ).toBeTruthy();
    expect(help.getByRole('link').getAttribute('href')).toBe(META_GUIDE_URL);
    expect((waDialog().getByLabelText('Name in Studio') as HTMLInputElement).value).toBe(
      'WhatsApp',
    );
    await user.click(waDialog().getByRole('button', { name: 'Next' }));
    const phone = waDialog().getByLabelText('Business phone number');
    expect(
      waDialog().getByText('Enter the number with + and the country code, like +971501234567.'),
    ).toBeTruthy();
    expect(
      waDialog().getByText('Enter the access token. It is at least 20 characters long.'),
    ).toBeTruthy();
    expect(phone.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(phone);
    expect(phone.getAttribute('dir')).toBe('ltr');

    await fillNumber(user);
    const token = waDialog().getByLabelText('Access token') as HTMLInputElement;
    expect(token.type).toBe('password');
    await user.click(waDialog().getByRole('button', { name: 'Show Access token' }));
    expect(token.type).toBe('text');
    await user.click(waDialog().getByRole('button', { name: 'Show Access token' }));
    expect(token.type).toBe('password');

    // Step 2: who answers.
    await user.click(waDialog().getByRole('button', { name: 'Next' }));
    expect(waStep()).toBe('Step 2 of 3');
    expect(document.activeElement?.textContent).toBe('Answering');
    await user.click(waDialog().getByRole('switch', { name: 'AI answers here' }));
    await user.selectOptions(waDialog().getByRole('combobox', { name: 'Team' }), 'team_billing');
    await user.click(waDialog().getByRole('button', { name: 'Connect' }));

    // Step 3: Meta's webhook set-up, in the same dialog.
    await waitFor(() => expect(waStep()).toBe('Step 3 of 3'));
    expect(gateway.to('POST', WHATSAPP).map((call) => call.body)).toEqual([
      {
        name: 'WhatsApp',
        phoneNumber: '+971501234567',
        phoneNumberId: '1098765',
        businessAccountId: '2234567',
        accessToken: TOKEN,
        aiAnswers: true,
        defaultTeamId: 'team_billing',
      },
    ]);
    expect(waDialog().getByRole('heading', { name: 'Set up Meta’s webhook' })).toBeTruthy();
    await waitFor(() =>
      expect(announced()).toBe('Your WhatsApp number is connected. Now set up Meta’s webhook.'),
    );
    expect(
      waDialog().getByText(
        'In Meta’s App Dashboard → WhatsApp → Configuration → Webhook, paste these, choose Verify and save, then subscribe to messages.',
      ),
    ).toBeTruthy();
    const callback = waDialog().getByLabelText('Callback URL') as HTMLInputElement;
    expect(callback.value).toBe(SET_UP.callbackUrl);
    expect(callback.readOnly).toBe(true);
    expect(callback.getAttribute('dir')).toBe('ltr');
    const verify = waDialog().getByLabelText('Verify token') as HTMLInputElement;
    expect(verify.value).toBe(SET_UP.verifyToken);
    expect(waDialog().queryByRole('button', { name: 'Back' })).toBeNull();
    // Nothing of the token is left in the form.
    expect(screen.queryByDisplayValue(TOKEN)).toBeNull();

    await user.click(waDialog().getByRole('button', { name: 'Copy Callback URL' }));
    expect(await navigator.clipboard.readText()).toBe(SET_UP.callbackUrl);
    await waitFor(() => expect(announced()).toBe('Copied'));
    expect(waDialog().getByTestId('whatsapp-connect-callback-copied').textContent).toBe('Copied');
    await user.click(waDialog().getByRole('button', { name: 'Copy Verify token' }));
    expect(await navigator.clipboard.readText()).toBe(SET_UP.verifyToken);

    await user.click(waDialog().getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('connect-whatsapp-dialog')).toBeNull());
    expect(screen.getByTestId('channel-saved').textContent).toBe(
      'WhatsApp connected. Messages arrive in your inbox once Meta’s webhook is set up.',
    );
    await waitFor(() =>
      expect(announced()).toBe(
        'WhatsApp connected. Messages arrive in your inbox once Meta’s webhook is set up.',
      ),
    );
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: 'WhatsApp' })).closest(
        'li',
      ) as HTMLElement,
    );
    expect(card.getByTestId('channel-address').textContent).toBe('+971501234567');
    expect(card.getByRole('button', { name: 'Meta set-up for WhatsApp' })).toBeTruthy();
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(TOKEN);
  });

  it('takes a token Meta refused back to the first step, next to the field, then connects', async () => {
    const gateway = messagingGateway([channel({ id: 'inb_old' as never, name: 'Old number' })], {
      whatsapp: (call) =>
        (call.body as { accessToken: string }).accessToken.startsWith('bad-token')
          ? refused('accessToken', 'Provider config Invalid Credentials')
          : undefined,
    });
    await page([channel({ id: 'inb_old' as never, name: 'Old number' })]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect WhatsApp' }));
    await screen.findByRole('dialog', { name: 'Connect WhatsApp' });
    await fillNumber(user, 'bad-token-from-a-test-user');
    await user.click(waDialog().getByRole('button', { name: 'Next' }));
    await user.click(waDialog().getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(waStep()).toBe('Step 1 of 3'));
    const token = waDialog().getByLabelText('Access token') as HTMLInputElement;
    expect(waDialog().getByText('Provider config Invalid Credentials')).toBeTruthy();
    expect(token.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(token));
    expect(waDialog().getByTestId('action-error')).toBeTruthy();
    // What was typed is kept, so only the token needs another go.
    expect((waDialog().getByLabelText('Phone number ID') as HTMLInputElement).value).toBe(
      '1098765',
    );

    await user.clear(token);
    await user.type(token, TOKEN);
    expect(waDialog().queryByText('Provider config Invalid Credentials')).toBeNull();
    await user.click(waDialog().getByRole('button', { name: 'Next' }));
    await user.click(waDialog().getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(waStep()).toBe('Step 3 of 3'));
    expect(gateway.to('POST', WHATSAPP)).toHaveLength(2);
  });

  it('shows the gateway’s words when Chatwoot cannot be reached', async () => {
    const detail = 'Chatwoot could not be reached to check this WhatsApp number. Please try again.';
    messagingGateway([], {
      whatsapp: () => ({
        status: 503,
        json: { status: 503, code: 'AUTHORITY_UNAVAILABLE', title: 'Unavailable', detail },
      }),
    });
    await page([]);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect WhatsApp' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect WhatsApp' });
    await fillNumber(user);
    await user.click(waDialog().getByRole('button', { name: 'Next' }));
    await user.click(waDialog().getByRole('button', { name: 'Connect' }));
    const alert = await waDialog().findByRole('alert');
    expect(within(alert).getByText('Chatwoot didn’t answer')).toBeTruthy();
    expect(within(alert).getByText(detail)).toBeTruthy();
    expect(waStep()).toBe('Step 2 of 3');
  });

  it('asks before throwing input away, and forgets the token when closed', async () => {
    messagingGateway([]);
    await page([]);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect WhatsApp' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect WhatsApp' });
    await user.type(waDialog().getByLabelText('Access token'), TOKEN);
    await user.keyboard('{Escape}');
    const ask = await screen.findByTestId('discard-changes');
    await user.click(within(ask).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByTestId('connect-whatsapp-dialog')).toBeNull());
    await user.click(screen.getAllByRole('button', { name: 'Connect WhatsApp' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect WhatsApp' });
    expect((waDialog().getByLabelText('Access token') as HTMLInputElement).value).toBe('');
  });
});

describe('Meta set-up on a WhatsApp card', () => {
  const setupDialog = () => within(screen.getByTestId('whatsapp-setup-dialog'));

  it('loads the callback URL and verify token from Chatwoot, with Copy', async () => {
    const gateway = messagingGateway([channel()]);
    await page([channel()]);
    const user = userEvent.setup();
    const card = within(
      screen.getByRole('heading', { level: 2, name: 'Shop WhatsApp' }).closest('li') as HTMLElement,
    );
    expect(card.getByTestId('channel-kind').textContent).toBe('WhatsApp');
    await user.click(card.getByRole('button', { name: 'Meta set-up for Shop WhatsApp' }));
    await screen.findByRole('dialog', { name: 'Set up Meta’s webhook' });
    const callback = (await setupDialog().findByLabelText('Callback URL')) as HTMLInputElement;
    expect(callback.value).toBe(SET_UP.callbackUrl);
    expect(gateway.to('GET', SETUP)).toHaveLength(1);
    await user.click(setupDialog().getByRole('button', { name: 'Copy Verify token' }));
    expect(await navigator.clipboard.readText()).toBe(SET_UP.verifyToken);
    await waitFor(() => expect(announced()).toBe('Copied'));
    await user.click(setupDialog().getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('whatsapp-setup-dialog')).toBeNull());
    expect(document.activeElement).toBe(
      card.getByRole('button', { name: 'Meta set-up for Shop WhatsApp' }),
    );
  });

  it('says when Chatwoot has no verify token yet', async () => {
    messagingGateway([channel()], { setup: () => ({ json: { ...SET_UP, verifyToken: null } }) });
    await page([channel()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Meta set-up for Shop WhatsApp' }));
    expect(
      await setupDialog().findByText(
        'Chatwoot hasn’t made a verify token yet. Open Meta set-up again in a moment.',
      ),
    ).toBeTruthy();
    expect(setupDialog().queryByLabelText('Verify token')).toBeNull();
  });

  it('shows the gateway’s words when the set-up cannot be read, and tries again', async () => {
    let fail = true;
    const detail = 'Chatwoot could not be reached to read the WhatsApp set-up. Please try again.';
    const gateway = messagingGateway([channel()], {
      setup: () =>
        fail
          ? {
              status: 503,
              json: { status: 503, code: 'AUTHORITY_UNAVAILABLE', title: 'Unavailable', detail },
            }
          : { json: SET_UP },
    });
    await page([channel()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Meta set-up for Shop WhatsApp' }));
    expect(await setupDialog().findByText(detail)).toBeTruthy();
    fail = false;
    await user.click(setupDialog().getByRole('button', { name: 'Try again' }));
    expect(((await setupDialog().findByLabelText('Callback URL')) as HTMLInputElement).value).toBe(
      SET_UP.callbackUrl,
    );
    expect(gateway.to('GET', SETUP).length).toBeGreaterThanOrEqual(2);
  });

  it('is offered on WhatsApp cards only', async () => {
    messagingGateway([channel({ id: 'inb_tg' as never, kind: 'telegram', name: 'Bot' })]);
    await page([channel({ id: 'inb_tg' as never, kind: 'telegram', name: 'Bot' })]);
    expect(screen.queryByTestId('channel-meta-setup')).toBeNull();
  });
});

describe('Connect Telegram', () => {
  it('sends the bot token and who answers; the card shows the bot’s @name', async () => {
    const gateway = messagingGateway([]);
    await page([]);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect Telegram' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect Telegram' });
    const help = within(tgDialog().getByTestId('telegram-help'));
    expect(
      help.getByText(
        'Message @BotFather on Telegram, send /newbot and copy the token it gives you.',
      ),
    ).toBeTruthy();
    expect(help.getByRole('link').getAttribute('href')).toBe(BOTFATHER_GUIDE_URL);
    expect((tgDialog().getByLabelText('Name in Studio') as HTMLInputElement).value).toBe(
      'Telegram',
    );
    const token = tgDialog().getByLabelText('Bot token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.getAttribute('dir')).toBe('ltr');

    // The token is checked before anything is sent.
    await user.type(token, 'not-a-token');
    await user.click(tgDialog().getByRole('button', { name: 'Connect' }));
    expect(
      tgDialog().getByText(
        'Enter the token from @BotFather. It looks like 123456789:AAH… with no spaces.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(token);
    expect(gateway.writes()).toEqual([]);

    await user.clear(token);
    await user.type(token, BOT_TOKEN);
    await user.click(tgDialog().getByRole('button', { name: 'Show Bot token' }));
    expect(token.type).toBe('text');
    await user.click(tgDialog().getByRole('switch', { name: 'AI answers here' }));
    await user.click(tgDialog().getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.queryByTestId('connect-telegram-dialog')).toBeNull());
    expect(gateway.to('POST', TELEGRAM).map((call) => call.body)).toEqual([
      { name: 'Telegram', botToken: BOT_TOKEN, aiAnswers: true, defaultTeamId: null },
    ]);
    const done = 'Telegram connected as @noor_books_bot. New messages will appear in your inbox.';
    expect(screen.getByTestId('channel-saved').textContent).toBe(done);
    await waitFor(() => expect(announced()).toBe(done));
    const card = within(
      (await screen.findByRole('heading', { level: 2, name: 'Telegram' })).closest(
        'li',
      ) as HTMLElement,
    );
    expect(card.getByTestId('channel-kind').textContent).toBe('Telegram');
    expect(card.getByTestId('channel-address').textContent).toBe('@noor_books_bot');
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(BOT_TOKEN);
  });

  it('puts a token Telegram refused next to its field', async () => {
    messagingGateway([], {
      telegram: () => refused('botToken', 'Bot token is invalid'),
    });
    await page([]);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Connect Telegram' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect Telegram' });
    const token = tgDialog().getByLabelText('Bot token');
    await user.type(token, '1234567:AAH-bad-token-abcdefghijklmnop');
    await user.click(tgDialog().getByRole('button', { name: 'Connect' }));
    expect(await tgDialog().findByText('Bot token is invalid')).toBeTruthy();
    expect(token.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(token));
    expect(screen.getByTestId('connect-telegram-dialog')).toBeTruthy();
  });
});
