// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import type { RoutingProfile } from '../src/lib/offers';
import { keys } from '../src/lib/queries';
import type { Team } from '../src/lib/types';
import { TeamsPage } from '../src/pages/settings/TeamsPage';
import { type Answer, type Call, fakeGateway, mountStudio, SELF_ID, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const agent = presetPermissions('agent');
const NOW = '2026-10-01T09:00:00.000Z';
const PROFILES = '/v1/admin/routing-profiles';

const put = (key: readonly unknown[], data: unknown) => (client: QueryClient) =>
  client.setQueryData([TENANT_ID, ...key], data);

const team = (patch: Partial<Team> = {}): Team => ({
  id: 'team_1',
  name: 'Support',
  workspaceId: 'wsp_1',
  status: 'active',
  members: [{ staffMemberId: 'staff_a', displayName: 'Amina' }],
  assignmentMode: 'queue',
  offerTimeoutSeconds: 60,
  createdAt: NOW,
  ...patch,
});
const member = (id: string, displayName: string) => ({
  id,
  displayName,
  email: `${displayName.toLowerCase()}@example.com`,
  status: 'active',
  grants: [],
  teams: [],
  lastActiveAt: null,
  manageable: false,
});
const people = [member('staff_a', 'Amina'), member('staff_b', 'Bilal'), member(SELF_ID, 'Omar')];
const profile = (patch: Partial<RoutingProfile> = {}): RoutingProfile => ({
  staffMemberId: 'staff_a',
  displayName: 'Amina',
  languages: ['en', 'ur'],
  maxOpenChats: 4,
  updatedAt: NOW,
  ...patch,
});
const profiles = [
  profile(),
  profile({
    staffMemberId: 'staff_b',
    displayName: 'Bilal',
    languages: [],
    maxOpenChats: null,
    updatedAt: null,
  }),
];

/** The teams page with these teams, everyone's languages answering from the gateway. */
async function page(
  teams: Team[],
  routes: Record<string, Answer | ((call: Call) => Answer)> = {},
  permissions: readonly string[] = owner,
) {
  const gateway = fakeGateway({
    'GET /v1/admin/teams': { json: { items: teams } },
    'GET /v1/admin/members': { json: { items: people } },
    [`GET ${PROFILES}`]: { json: { items: profiles } },
    ...routes,
  });
  await mountStudio({
    at: '/support-teams',
    permissions,
    screen: <TeamsPage />,
    seed: (client) => {
      put(accessKeys.teams, { items: teams })(client);
      put(keys.members, { items: people })(client);
    },
  });
  return gateway;
}

const card = (name: string) => {
  const found = screen.getAllByTestId('team-card').find((el) => el.dataset.team === name);
  if (!found) throw new Error(`no card for ${name}`);
  return found;
};
const row = async (staffMemberId: string) => {
  const list = await screen.findByTestId('routing-profiles');
  const found = within(list)
    .getAllByTestId('routing-profile')
    .find((el) => el.dataset.staff === staffMemberId);
  if (!found) throw new Error(`no row for ${staffMemberId}`);
  return found;
};
const announced = () => document.querySelector('[data-slot="announcer-polite"]')?.textContent;

// ------------------------------------------------------------------ how chats arrive

describe('how chats arrive in a team (HNV-10-03)', () => {
  it('says whether chats wait in the queue or are offered one person at a time', async () => {
    await page([
      team(),
      team({ id: 'team_2', name: 'Sales', assignmentMode: 'offer', offerTimeoutSeconds: 45 }),
    ]);
    expect(within(card('Support')).getByTestId('team-arrival').textContent).toBe(
      'New chats wait in the team’s queue for anyone to take.',
    );
    expect(within(card('Sales')).getByTestId('team-arrival').textContent).toBe(
      'New chats are offered to one person at a time, 45 seconds each.',
    );
  });

  it('turns offers on with the seconds to accept, refusing seconds out of range', async () => {
    let now = team();
    const gateway = await page([now], {
      'GET /v1/admin/teams': () => ({ json: { items: [now] } }),
      'PATCH /v1/admin/teams/team_1': (call) => {
        now = { ...now, ...(call.body as Partial<Team>) };
        return { json: now };
      },
    });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Change how chats arrive in Support' }));
    const dialog = await screen.findByTestId('team-offers-dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'How chats arrive in Support' }),
    ).toBeTruthy();
    const queue = within(dialog).getByRole('radio', { name: 'Everyone sees it' });
    expect(queue.getAttribute('aria-checked')).toBe('true');
    // The seconds matter only when offering.
    expect(within(dialog).queryByLabelText('Seconds to accept')).toBeNull();

    await user.click(
      within(dialog).getByRole('radio', { name: 'Offer it to one person at a time' }),
    );
    const seconds = within(dialog).getByLabelText('Seconds to accept') as HTMLInputElement;
    expect(seconds.value).toBe('60');
    expect(seconds.getAttribute('inputmode')).toBe('numeric');
    await user.clear(seconds);
    await user.type(seconds, '5');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const summary = dialog.querySelector('[data-slot="form-error-summary"]');
    expect(summary?.textContent).toContain('Enter a number of seconds from 15 to 600.');
    expect(seconds.getAttribute('aria-invalid')).toBe('true');
    expect(gateway.to('PATCH', '/v1/admin/teams/team_1')).toHaveLength(0);

    await user.clear(seconds);
    await user.type(seconds, '45');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(gateway.to('PATCH', '/v1/admin/teams/team_1')).toHaveLength(1));
    expect(gateway.to('PATCH', '/v1/admin/teams/team_1')[0]?.body).toEqual({
      assignmentMode: 'offer',
      offerTimeoutSeconds: 45,
    });
    await waitFor(() => expect(screen.queryByTestId('team-offers-dialog')).toBeNull());
    await waitFor(() => expect(announced()).toBe('Saved how chats arrive in Support.'));
    await waitFor(() =>
      expect(within(card('Support')).getByTestId('team-arrival').textContent).toBe(
        'New chats are offered to one person at a time, 45 seconds each.',
      ),
    );
  });

  it('sends only the mode when going back to the queue', async () => {
    const gateway = await page([team({ assignmentMode: 'offer', offerTimeoutSeconds: 90 })], {
      'PATCH /v1/admin/teams/team_1': { json: team() },
    });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Change how chats arrive in Support' }));
    const dialog = await screen.findByTestId('team-offers-dialog');
    expect((within(dialog).getByLabelText('Seconds to accept') as HTMLInputElement).value).toBe(
      '90',
    );
    await user.click(within(dialog).getByRole('radio', { name: 'Everyone sees it' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(gateway.to('PATCH', '/v1/admin/teams/team_1')[0]?.body).toEqual({
        assignmentMode: 'queue',
      }),
    );
  });

  it('keeps the dialog open with the reason when the gateway refuses', async () => {
    await page([team()], {
      'PATCH /v1/admin/teams/team_1': {
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'offerTimeoutSeconds', message: 'Too long' }],
        },
      },
    });
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Change how chats arrive in Support' }));
    const dialog = await screen.findByTestId('team-offers-dialog');
    await user.click(
      within(dialog).getByRole('radio', { name: 'Offer it to one person at a time' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByTestId('action-error')).toBeTruthy();
    expect(screen.getByTestId('team-offers-dialog')).toBeTruthy();
  });

  it('starts again from the team as it is each time the dialog opens', async () => {
    await page([team()]);
    const user = userEvent.setup({ delay: null });
    const open = screen.getByRole('button', { name: 'Change how chats arrive in Support' });
    await user.click(open);
    let dialog = await screen.findByTestId('team-offers-dialog');
    await user.click(
      within(dialog).getByRole('radio', { name: 'Offer it to one person at a time' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByTestId('team-offers-dialog')).toBeNull());
    await user.click(open);
    dialog = await screen.findByTestId('team-offers-dialog');
    expect(
      within(dialog).getByRole('radio', { name: 'Everyone sees it' }).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

// ------------------------------------------------------------------ languages and limits

describe('everyone’s languages and limits', () => {
  it('lists each person with the languages they answer in and their limit', async () => {
    await page([team()]);
    const section = screen.getByRole('region', { name: 'Languages and limits' });
    expect(section.textContent).toContain('Chats are offered first to people who speak');
    const amina = await row('staff_a');
    expect(amina.textContent).toContain('Amina');
    expect(amina.textContent).toContain('English, Urdu');
    expect(amina.textContent).toContain('Up to 4 open chats');
    const bilal = await row('staff_b');
    expect(bilal.textContent).toContain('No languages listed');
    expect(bilal.textContent).toContain('No limit');
  });

  it('saves the languages ticked, in Studio’s order, and the limit typed', async () => {
    const gateway = await page([team()], {
      [`PUT ${PROFILES}/staff_b`]: (call) => ({
        json: profile({
          staffMemberId: 'staff_b',
          displayName: 'Bilal',
          ...(call.body as Partial<RoutingProfile>),
        }),
      }),
    });
    const user = userEvent.setup({ delay: null });
    await user.click(
      within(await row('staff_b')).getByRole('button', {
        name: 'Edit languages and limit for Bilal',
      }),
    );
    const dialog = await screen.findByTestId('routing-profile-dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Languages and limit for Bilal' }),
    ).toBeTruthy();
    expect(within(dialog).getByRole('group', { name: 'Languages they answer in' })).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Hindi' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'English' }));
    await user.type(within(dialog).getByLabelText('Most open chats at once'), '3');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(gateway.to('PUT', `${PROFILES}/staff_b`)).toHaveLength(1));
    expect(gateway.to('PUT', `${PROFILES}/staff_b`)[0]?.body).toEqual({
      languages: ['en', 'hi'],
      maxOpenChats: 3,
    });
    await waitFor(() => expect(screen.queryByTestId('routing-profile-dialog')).toBeNull());
    await waitFor(() => expect(announced()).toBe('Saved languages and limit for Bilal.'));
  });

  it('sends no limit when the limit is left empty', async () => {
    const gateway = await page([team()], {
      [`PUT ${PROFILES}/staff_a`]: (call) => ({
        json: profile(call.body as Partial<RoutingProfile>),
      }),
    });
    const user = userEvent.setup({ delay: null });
    await user.click(
      within(await row('staff_a')).getByRole('button', {
        name: 'Edit languages and limit for Amina',
      }),
    );
    const dialog = await screen.findByTestId('routing-profile-dialog');
    expect(
      (within(dialog).getByRole('checkbox', { name: 'Urdu' }) as HTMLButtonElement).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
    const max = within(dialog).getByLabelText('Most open chats at once') as HTMLInputElement;
    expect(max.value).toBe('4');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Urdu' }));
    await user.clear(max);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(gateway.to('PUT', `${PROFILES}/staff_a`)[0]?.body).toEqual({
        languages: ['en'],
        maxOpenChats: null,
      }),
    );
  });

  it('refuses a limit out of range and sends nothing', async () => {
    const gateway = await page([team()]);
    const user = userEvent.setup({ delay: null });
    await user.click(
      within(await row('staff_a')).getByRole('button', {
        name: 'Edit languages and limit for Amina',
      }),
    );
    const dialog = await screen.findByTestId('routing-profile-dialog');
    const max = within(dialog).getByLabelText('Most open chats at once');
    await user.clear(max);
    await user.type(max, '60');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    const summary = dialog.querySelector('[data-slot="form-error-summary"]');
    expect(summary?.textContent).toContain('Enter a number from 1 to 50, or leave it empty.');
    expect(max.getAttribute('aria-invalid')).toBe('true');
    expect(gateway.writes()).toHaveLength(0);
  });

  it('still shows the teams when the languages cannot be loaded', async () => {
    await page([team()], {
      [`GET ${PROFILES}`]: { problem: { status: 503, code: 'UNAVAILABLE' } },
    });
    const section = screen.getByRole('region', { name: 'Languages and limits' });
    expect(await within(section).findByRole('button', { name: /try again/i })).toBeTruthy();
    expect(within(card('Support')).getByText('Amina')).toBeTruthy();
    expect(screen.queryByTestId('routing-profiles')).toBeNull();
  });
});

// ------------------------------------------------------------------ without teams.manage

describe('someone who may not manage teams', () => {
  it('sees how chats arrive and everyone’s languages, with nothing to change', async () => {
    await page([team({ assignmentMode: 'offer', offerTimeoutSeconds: 30 })], {}, agent);
    expect(within(card('Support')).getByTestId('team-arrival').textContent).toBe(
      'New chats are offered to one person at a time, 30 seconds each.',
    );
    expect(screen.queryByRole('button', { name: /how chats arrive/i })).toBeNull();
    expect((await row('staff_a')).textContent).toContain('English, Urdu');
    expect(screen.queryByRole('button', { name: /Edit languages and limit/ })).toBeNull();
  });
});
