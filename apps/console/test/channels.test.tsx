// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import {
  applyChange,
  type ChannelInbox,
  channelKeys,
  newChannelCount,
  orderChannels,
  teamsForBrand,
} from '../src/lib/channels';
import { keys } from '../src/lib/queries';
import type { Team } from '../src/lib/types';
import { ChannelsPage } from '../src/pages/channels/ChannelsPage';
import { type Call, fakeGateway, mountStudio, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-09T09:00:00.000Z';
const LIST = '/v1/admin/brands/brd_1/channels';

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
const team = (id: string, name: string, workspaceId: string | null = 'wsp_1'): Team =>
  ({ id, name, workspaceId, status: 'active', members: [], createdAt: NOW }) as Team;
const TEAMS = [team('team_billing', 'Billing'), team('team_sales', 'Sales')];

const channel = (overrides: Partial<ChannelInbox> = {}): ChannelInbox =>
  ({
    id: 'inb_mail',
    brandId: 'brd_1',
    kind: 'email',
    name: 'Support email',
    address: 'help@noor.example',
    status: 'connected',
    problem: null,
    aiAnswers: false,
    defaultTeamId: null,
    conversationsThisWeek: 3,
    lastEventAt: null,
    pausedAt: null,
    createdAt: NOW,
    ...overrides,
  }) as ChannelInbox;

/** A gateway that keeps the brand's channels and changes them as asked. */
function channelsGateway(
  start: ChannelInbox[],
  options: { later?: ChannelInbox[]; put?: (call: Call) => unknown } = {},
) {
  let items = [...start];
  const gateway = fakeGateway({
    [`GET ${LIST}`]: () => ({ json: { items } }),
    [`POST ${LIST}/find`]: () => {
      items = [...items, ...(options.later ?? [])];
      return { json: { items } };
    },
    ...Object.fromEntries(
      [...start, ...(options.later ?? [])].map((c) => [
        `PUT /v1/admin/channels/${c.id}`,
        (call: Call) => {
          const special = options.put?.(call);
          if (special) return special as never;
          const body = call.body ?? {};
          items = items.map((one) =>
            one.id === c.id
              ? applyChange(one, {
                  ...(body.aiAnswers !== undefined ? { aiAnswers: body.aiAnswers as boolean } : {}),
                  ...(body.defaultTeamId !== undefined
                    ? { defaultTeamId: body.defaultTeamId as never }
                    : {}),
                  ...(body.paused !== undefined ? { paused: body.paused as boolean } : {}),
                  ...(body.brandId !== undefined ? { brandId: body.brandId as never } : {}),
                })
              : one,
          );
          return { json: items.find((one) => one.id === c.id) };
        },
      ]),
    ),
  });
  return gateway;
}

const seed =
  (items: ChannelInbox[] | null, teams: Team[] = TEAMS) =>
  (client: QueryClient) => {
    client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
    client.setQueryData([TENANT_ID, ...keys.workspaces], { items: [workspace] });
    client.setQueryData([TENANT_ID, ...accessKeys.teams], { items: teams });
    if (items) client.setQueryData([TENANT_ID, ...channelKeys.list('brd_1')], { items });
  };

const page = (items: ChannelInbox[] | null, permissions: readonly string[] = owner) =>
  mountStudio({
    at: '/channels?brand=brd_1',
    permissions,
    screen: <ChannelsPage />,
    seed: seed(items),
  });

const card = (name: string) => {
  const heading = screen.getByRole('heading', { level: 2, name });
  const item = heading.closest('li');
  if (!item) throw new Error(`no card for ${name}`);
  return within(item);
};

describe('channel helpers', () => {
  it('shows a change at once: AI, team, pausing, resuming and claiming', () => {
    const base = channel();
    expect(applyChange(base, { aiAnswers: true }).aiAnswers).toBe(true);
    expect(applyChange(base, { defaultTeamId: 'team_x' as never }).defaultTeamId).toBe('team_x');
    const paused = applyChange(base, { paused: true }, NOW);
    expect(paused).toMatchObject({ status: 'paused', pausedAt: NOW });
    expect(applyChange(paused, { paused: false })).toMatchObject({
      status: 'connected',
      pausedAt: null,
    });
    expect(
      applyChange(channel({ status: 'paused', problem: 'IMAP login failed' }), { paused: false })
        .status,
    ).toBe('needs_attention');
    expect(applyChange(channel({ brandId: null }), { brandId: 'brd_1' as never }).brandId).toBe(
      'brd_1',
    );
  });

  it('counts only channels the list did not have, and lists unclaimed ones last', () => {
    const mail = channel();
    const wa = channel({ id: 'inb_wa' as never, kind: 'whatsapp' });
    expect(newChannelCount([mail], [mail, wa])).toBe(1);
    expect(newChannelCount(undefined, [mail])).toBe(1);
    expect(newChannelCount([mail, wa], [mail, wa])).toBe(0);
    const free = channel({ id: 'inb_free' as never, brandId: null });
    expect(orderChannels([free, mail]).map((c) => c.id)).toEqual(['inb_mail', 'inb_free']);
  });

  it('offers the active teams of the brand’s workspace and shared ones, by name', () => {
    const teams = [
      team('team_z', 'Zeta'),
      team('team_shared', 'Everyone', null),
      team('team_other', 'Other workspace', 'wsp_2'),
      { ...team('team_old', 'Archived'), status: 'archived' } as Team,
    ];
    expect(teamsForBrand(teams, 'wsp_1').map((t) => t.name)).toEqual(['Everyone', 'Zeta']);
  });
});

describe('the Channels page', () => {
  it('shows web chat and an empty state, then finds a new channel', async () => {
    const gateway = channelsGateway([], { later: [channel()] });
    await page([]);
    expect(screen.getByRole('heading', { level: 1, name: 'Channels' })).toBeTruthy();
    expect(
      screen.getByText('Answer email, WhatsApp and Telegram from the same inbox as your web chat.'),
    ).toBeTruthy();
    const web = card('Web chat');
    expect(web.getByText('Connected')).toBeTruthy();
    expect(web.getByText('Your website’s chat widget.')).toBeTruthy();
    expect(web.getByRole('link', { name: 'Chat widget settings' }).getAttribute('href')).toBe(
      '/chat-widget?brand=brd_1',
    );
    const empty = screen.getByTestId('channels-empty');
    expect(within(empty).getByText('No email, WhatsApp or Telegram channels yet.')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(within(empty).getByRole('button', { name: 'Check for new channels' }));
    expect((await screen.findByTestId('channel-saved')).textContent).toBe('Found 1 new channel');
    await waitFor(() =>
      expect(document.querySelector('[data-slot="announcer-polite"]')?.textContent).toBe(
        'Found 1 new channel',
      ),
    );
    expect(gateway.to('POST', `${LIST}/find`)).toHaveLength(1);
    expect(card('Support email').getByText('help@noor.example')).toBeTruthy();
    expect(screen.queryByTestId('channels-empty')).toBeNull();
  });

  it('says so when a check finds nothing new', async () => {
    channelsGateway([channel()]);
    await page([channel()]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Check for new channels' }));
    expect((await screen.findByTestId('channel-saved')).textContent).toBe('No new channels');
  });

  it('describes a channel: kind, address, status with its problem, and activity', async () => {
    channelsGateway([]);
    await page([
      channel({
        status: 'needs_attention',
        problem: 'IMAP login failed',
        conversationsThisWeek: 12,
        lastEventAt: new Date(Date.now() - 5 * 60_000).toISOString() as never,
      }),
      channel({
        id: 'inb_tg' as never,
        kind: 'telegram',
        name: 'Noor bot',
        address: '@noor_bot',
        status: 'paused',
        conversationsThisWeek: 1,
      }),
    ]);
    const mail = card('Support email');
    expect(mail.getByText('Email')).toBeTruthy();
    expect(mail.getByText('Needs attention')).toBeTruthy();
    expect(mail.getByText('Chatwoot says: IMAP login failed')).toBeTruthy();
    expect(mail.getByText('12 conversations this week')).toBeTruthy();
    expect(mail.getByText('Last message: 5 minutes ago')).toBeTruthy();
    const bot = card('Noor bot');
    expect(bot.getByText('Telegram')).toBeTruthy();
    expect(bot.getByText('Paused')).toBeTruthy();
    expect(bot.getByText('1 conversation this week')).toBeTruthy();
    expect(bot.getByText('No messages yet')).toBeTruthy();
    expect(bot.getByRole('button', { name: 'Resume Noor bot' })).toBeTruthy();
  });

  it('turns the AI on, sends new conversations to a team, and pauses after confirming', async () => {
    const gateway = channelsGateway([channel()]);
    await page([channel()]);
    const user = userEvent.setup();
    const mail = card('Support email');

    const ai = mail.getByRole('switch', { name: 'AI answers here Support email' });
    expect(ai.getAttribute('aria-checked')).toBe('false');
    expect(ai.getAttribute('aria-describedby')).toBeTruthy();
    await user.click(ai);
    expect(ai.getAttribute('aria-checked')).toBe('true');
    expect(await mail.findByText('The AI now answers first on Support email.')).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/channels/inb_mail')[0]?.body).toEqual({ aiAnswers: true });

    const teamSelect = mail.getByRole('combobox', { name: 'Team' }) as HTMLSelectElement;
    expect([...teamSelect.options].map((o) => o.text)).toEqual([
      'No team (use routing)',
      'Billing',
      'Sales',
    ]);
    await user.selectOptions(teamSelect, 'team_sales');
    expect(
      await mail.findByText('New conversations on Support email now go to Sales.'),
    ).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/channels/inb_mail')[1]?.body).toEqual({
      defaultTeamId: 'team_sales',
    });

    await user.click(mail.getByRole('button', { name: 'Pause Support email' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pause Support email?' });
    expect(
      within(dialog).getByText(
        'New conversations on this channel stay in Chatwoot until you resume. Conversations already here carry on.',
      ),
    ).toBeTruthy();
    // Nothing is sent before confirming.
    expect(gateway.to('PUT', '/v1/admin/channels/inb_mail')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Pause channel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(gateway.to('PUT', '/v1/admin/channels/inb_mail')[2]?.body).toEqual({ paused: true });
    expect(await mail.findByText('Paused')).toBeTruthy();
    expect(mail.getByRole('button', { name: 'Resume Support email' })).toBeTruthy();
  });

  it('claims a channel found in the Chatwoot account for the brand', async () => {
    const free = channel({
      id: 'inb_wa' as never,
      kind: 'whatsapp',
      name: 'Sales WhatsApp',
      brandId: null,
      address: '+971500000000',
    });
    const gateway = channelsGateway([free]);
    await page([free]);
    const wa = card('Sales WhatsApp');
    expect(wa.getByText('Found in your Chatwoot account.')).toBeTruthy();
    expect(wa.queryByRole('switch')).toBeNull();
    const user = userEvent.setup();
    await user.click(wa.getByRole('button', { name: 'Use for this brand' }));
    expect(await wa.findByText('Sales WhatsApp now answers for Noor Books.')).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/channels/inb_wa')[0]?.body).toEqual({ brandId: 'brd_1' });
    expect(wa.getByRole('switch', { name: 'AI answers here Sales WhatsApp' })).toBeTruthy();
  });

  it('shows the gateway’s words when Chatwoot could not be updated', async () => {
    const detail =
      'The setting is saved, but Chatwoot could not hand this channel to the AI yet. Please try again.';
    channelsGateway([channel()], {
      put: () => ({
        status: 503,
        json: { status: 503, code: 'AUTHORITY_UNAVAILABLE', title: 'Unavailable', detail },
      }),
    });
    await page([channel()]);
    const user = userEvent.setup();
    const mail = card('Support email');
    await user.click(mail.getByRole('switch', { name: 'AI answers here Support email' }));
    const alert = await mail.findByRole('alert');
    expect(within(alert).getByText('Chatwoot didn’t answer')).toBeTruthy();
    expect(within(alert).getByText(detail)).toBeTruthy();
  });

  it('shows a field problem next to the team', async () => {
    channelsGateway([channel()], {
      put: () => ({
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'defaultTeamId', message: 'That team no longer exists.' }],
        },
      }),
    });
    await page([channel()]);
    const user = userEvent.setup();
    const mail = card('Support email');
    await user.selectOptions(mail.getByRole('combobox', { name: 'Team' }), 'team_billing');
    expect(await mail.findByText('That team no longer exists.')).toBeTruthy();
    // Put back as it was.
    await waitFor(() =>
      expect((mail.getByRole('combobox', { name: 'Team' }) as HTMLSelectElement).value).toBe(''),
    );
  });

  it('is only for people who may manage integrations', async () => {
    const gateway = channelsGateway([]);
    await page(null, presetPermissions('agent'));
    expect(screen.getByText('You can’t manage channels')).toBeTruthy();
    expect(gateway.to('GET', LIST)).toEqual([]);
  });
});
