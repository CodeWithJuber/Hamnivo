// @vitest-environment jsdom
import * as contracts from '@hamnivo/contracts';
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import {
  applyProvider,
  type ChannelInbox,
  channelKeys,
  connectEmailBody,
  draftFromSettings,
  EMAIL_PROVIDERS,
  type EmailSettings,
  emailProvider,
  emailStepFields,
  emailStepOf,
  emptyEmailDraft,
  invalidEmailFields,
  providerForAddress,
  updateEmailBody,
  withAddress,
} from '../src/lib/channels';
import { keys } from '../src/lib/queries';
import type { Team } from '../src/lib/types';
import { ChannelsPage } from '../src/pages/channels/ChannelsPage';
import { type Answer, type Call, fakeGateway, mountStudio, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-09T09:00:00.000Z';
const LIST = '/v1/admin/brands/brd_1/channels';
const CONNECT = `${LIST}/email`;
const SETTINGS = '/v1/admin/channels/inb_mail/email';

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
    id: 'inb_mail',
    brandId: 'brd_1',
    kind: 'email',
    name: 'Support email',
    address: 'help@noor.example',
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

const settings: EmailSettings = {
  name: 'Support email',
  address: 'help@noor.example',
  imap: { address: 'mail.noor.example', port: 993, ssl: true, login: 'help@noor.example' },
  smtp: {
    address: 'mail.noor.example',
    port: 587,
    security: 'starttls',
    login: 'help@noor.example',
  },
};

/** A gateway with the brand's channels, Connect email and Email settings. */
function emailGateway(
  start: ChannelInbox[],
  options: { connect?: (call: Call) => Answer | undefined; save?: (call: Call) => Answer } = {},
) {
  let items = [...start];
  return fakeGateway({
    [`GET ${LIST}`]: () => ({ json: { items } }),
    [`POST ${CONNECT}`]: (call) => {
      const special = options.connect?.(call);
      if (special) return special;
      const body = call.body as { name: string; address: string; aiAnswers: boolean };
      const added = channel({
        id: 'inb_new' as never,
        name: body.name,
        address: body.address,
        aiAnswers: body.aiAnswers,
      });
      items = [...items, added];
      return { status: 201, json: added };
    },
    [`GET ${SETTINGS}`]: () => ({ json: settings }),
    [`PUT ${SETTINGS}`]: (call) => {
      if (options.save) return options.save(call);
      items = items.map((one) =>
        one.id === 'inb_mail' ? { ...one, status: 'connected', problem: null } : one,
      );
      return { json: items.find((one) => one.id === 'inb_mail') };
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

const dialog = () => within(screen.getByTestId('connect-email-dialog'));
const stepText = () => screen.getByTestId('email-step').textContent;
const next = (user: UserEvent) => user.click(dialog().getByRole('button', { name: 'Next' }));
const announced = () => document.querySelector('[data-slot="announcer-polite"]')?.textContent;

/** Opens Connect email and fills step 1 with an address. */
async function startConnect(user: UserEvent, address: string) {
  await user.click(screen.getAllByRole('button', { name: 'Connect email' })[0] as HTMLElement);
  await screen.findByRole('dialog', { name: 'Connect email' });
  expect(stepText()).toBe('Step 1 of 4');
  await user.type(dialog().getByLabelText('Support address'), address);
}

describe('email helpers', () => {
  it('knows the same providers as the contract', () => {
    expect(EMAIL_PROVIDERS).toEqual(contracts.EMAIL_PROVIDERS);
  });

  it('checks fields exactly as the contract does', () => {
    const base = withAddress(emptyEmailDraft('Support email'), 'help@noor.example');
    const filled = {
      ...base,
      imap: { ...base.imap, address: 'mail.noor.example', password: 'secret' },
      smtp: { ...base.smtp, address: 'mail.noor.example', password: 'secret' },
      sameLogin: false,
    };
    const variants: Array<[string, Partial<typeof filled>]> = [
      ['ok', {}],
      ['blank name', { name: '   ' }],
      ['long name', { name: 'x'.repeat(101) }],
      ['no at', { address: 'help.noor.example' }],
      ['no domain dot', { address: 'help@noor' }],
      ['double dot', { address: 'help..desk@noor.example' }],
      ['plus', { address: 'help+shop@noor.example' }],
      ['port 0', { imap: { ...filled.imap, port: '0' } }],
      ['port 65536', { smtp: { ...filled.smtp, port: '65536' } }],
      ['port text', { imap: { ...filled.imap, port: '99a' } }],
      ['blank server', { imap: { ...filled.imap, address: ' ' } }],
      ['blank login', { smtp: { ...filled.smtp, login: '' } }],
      ['no password', { imap: { ...filled.imap, password: '' } }],
      ['long password', { smtp: { ...filled.smtp, password: 'p'.repeat(501) } }],
    ];
    const all = [1, 2, 3].flatMap((step) => emailStepFields(step as 1 | 2 | 3, filled));
    for (const [label, change] of variants) {
      const draft = { ...filled, ...change };
      const parsed = contracts.ConnectEmailRequest.safeParse(connectEmailBody(draft));
      const theirs = parsed.success
        ? []
        : [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      expect(invalidEmailFields(draft, all).sort(), label).toEqual(theirs.sort());
    }
  });

  it('finds the provider from the address domain, and Another provider otherwise', () => {
    expect(providerForAddress('help@gmail.com').id).toBe('gmail');
    expect(providerForAddress(' Help@GoogleMail.com ').id).toBe('gmail');
    expect(providerForAddress('desk@zoho.com').id).toBe('zoho');
    expect(providerForAddress('me@ymail.com').id).toBe('yahoo');
    expect(providerForAddress('me@fastmail.fm').id).toBe('fastmail');
    expect(providerForAddress('shop@hotmail.com')).toMatchObject({
      id: 'microsoft',
      passwordsWork: false,
    });
    expect(providerForAddress('help@noor.example').id).toBe('custom');
    expect(providerForAddress('not an address').id).toBe('custom');
  });

  it('fills servers, ports and security from a provider; Another provider leaves them', () => {
    const draft = applyProvider(emptyEmailDraft('Support email'), emailProvider('zoho') as never);
    expect(draft.imap).toMatchObject({ address: 'imap.zoho.com', port: '993', ssl: true });
    expect(draft.smtp).toMatchObject({ address: 'smtp.zoho.com', port: '465', security: 'tls' });
    const custom = applyProvider(draft, emailProvider('custom') as never);
    expect(custom.provider).toBe('custom');
    expect(custom.imap.address).toBe('imap.zoho.com');
  });

  it('keeps logins on the address until someone types another', () => {
    let draft = withAddress(emptyEmailDraft('Support email'), 'a@noor.example');
    expect(draft.imap.login).toBe('a@noor.example');
    draft = withAddress(draft, 'help@noor.example');
    expect(draft.imap.login).toBe('help@noor.example');
    draft = { ...draft, imap: { ...draft.imap, login: 'help' } };
    expect(withAddress(draft, 'desk@noor.example').imap.login).toBe('help');
  });

  it('checks each step with the contract and knows which step holds a field', () => {
    const draft = emptyEmailDraft('Support email');
    expect(invalidEmailFields(draft, emailStepFields(1, draft))).toEqual(['address']);
    expect(
      invalidEmailFields({ ...draft, name: ' ', address: 'nope' }, emailStepFields(1, draft)),
    ).toEqual(['address', 'name']);
    const ports = { ...draft, imap: { ...draft.imap, port: '99999' } };
    expect(invalidEmailFields(ports, emailStepFields(2, draft))).toEqual([
      'imap.address',
      'imap.port',
      'imap.login',
      'imap.password',
    ]);
    expect(emailStepFields(3, draft)).toEqual(['smtp.address', 'smtp.port']);
    expect(emailStepFields(3, { ...draft, sameLogin: false })).toContain('smtp.password');
    expect(
      ['address', 'imap.password', 'smtp.port', 'defaultTeamId', 'other'].map(emailStepOf),
    ).toEqual([1, 2, 3, 4, null]);
  });

  it('sends the incoming login and password for outgoing mail when they are the same', () => {
    const draft = {
      ...applyProvider(
        withAddress(emptyEmailDraft('Support email'), 'help@gmail.com'),
        emailProvider('gmail') as never,
      ),
      imap: {
        address: 'imap.gmail.com',
        port: '993',
        ssl: true,
        login: 'help@gmail.com',
        password: 'app pass',
      },
    };
    expect(connectEmailBody(draft).smtp).toEqual({
      address: 'smtp.gmail.com',
      port: 587,
      security: 'starttls',
      login: 'help@gmail.com',
      password: 'app pass',
    });
    const own = {
      ...draft,
      sameLogin: false,
      smtp: { ...draft.smtp, login: 'out@gmail.com', password: 'other' },
    };
    expect(connectEmailBody(own).smtp).toMatchObject({ login: 'out@gmail.com', password: 'other' });
  });

  it('saves settings without passwords unless one is being changed', () => {
    const draft = draftFromSettings(settings);
    expect(draft.imap.password).toBe('');
    const body = updateEmailBody(draft, { imap: false, smtp: false });
    expect(body.imap).not.toHaveProperty('password');
    expect(body.smtp).not.toHaveProperty('password');
    const changed = updateEmailBody(
      { ...draft, imap: { ...draft.imap, password: 'new' } },
      { imap: true, smtp: false },
    );
    expect(changed.imap.password).toBe('new');
    expect(changed.smtp).not.toHaveProperty('password');
  });
});

describe('Connect email', () => {
  it('walks the four steps with found settings and sends exactly what was entered', async () => {
    const gateway = emailGateway([]);
    await page([]);
    const user = userEvent.setup({ delay: null });
    const empty = within(screen.getByTestId('channels-empty'));
    expect(empty.getByRole('button', { name: 'Connect email' })).toBeTruthy();
    expect(empty.getByRole('button', { name: 'Check for new channels' })).toBeTruthy();
    await user.click(empty.getByRole('button', { name: 'Connect email' }));
    await screen.findByRole('dialog', { name: 'Connect email' });

    // Step 1: the address is needed before anything else.
    expect(stepText()).toBe('Step 1 of 4');
    expect(dialog().getByRole('heading', { name: 'Your address' })).toBeTruthy();
    expect(dialog().getByRole('link', { name: 'How to connect email' })).toBeTruthy();
    expect((dialog().getByLabelText('Name in Studio') as HTMLInputElement).value).toBe(
      'Support email',
    );
    await next(user);
    const address = dialog().getByLabelText('Support address');
    expect(dialog().getByText('Enter an email address, like help@yourshop.com.')).toBeTruthy();
    expect(address.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(address);
    expect(address.getAttribute('dir')).toBe('ltr');

    await user.type(address, 'help@gmail.com');
    await user.click(dialog().getByRole('button', { name: 'Find my settings' }));
    expect(
      dialog().getByText('We filled in the settings for Gmail / Google Workspace.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(announced()).toBe('We filled in the settings for Gmail / Google Workspace.'),
    );
    expect((dialog().getByLabelText('Email provider') as HTMLSelectElement).value).toBe('gmail');
    const appPassword = within(dialog().getByTestId('app-password'));
    expect(appPassword.getByText('Use an app password')).toBeTruthy();
    expect(
      appPassword.getByText(
        'Your provider asks for an app password instead of your normal password.',
      ),
    ).toBeTruthy();
    expect(appPassword.getByRole('link').getAttribute('href')).toBe(
      'https://myaccount.google.com/apppasswords',
    );

    // Step 2: servers filled in, login is the address; the password is required.
    await next(user);
    expect(stepText()).toBe('Step 2 of 4');
    expect(document.activeElement?.textContent).toBe('Incoming mail (IMAP)');
    expect((dialog().getByLabelText('Incoming mail server') as HTMLInputElement).value).toBe(
      'imap.gmail.com',
    );
    expect((dialog().getByLabelText('Incoming port') as HTMLInputElement).value).toBe('993');
    expect(dialog().getByRole('switch', { name: 'Use SSL' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect((dialog().getByLabelText('Incoming login') as HTMLInputElement).value).toBe(
      'help@gmail.com',
    );
    await next(user);
    expect(stepText()).toBe('Step 2 of 4');
    expect(dialog().getByText('Enter the password.')).toBeTruthy();
    const password = dialog().getByLabelText('Incoming password') as HTMLInputElement;
    expect(document.activeElement).toBe(password);
    expect(password.type).toBe('password');
    await user.type(password, 'abcd efgh ijkl mnop');
    await user.click(dialog().getByRole('button', { name: 'Show Incoming password' }));
    expect(password.type).toBe('text');
    await user.click(dialog().getByRole('button', { name: 'Show Incoming password' }));
    expect(password.type).toBe('password');

    // Step 3: outgoing server filled in; same login and password by default.
    await next(user);
    expect(stepText()).toBe('Step 3 of 4');
    expect((dialog().getByLabelText('Outgoing mail server') as HTMLInputElement).value).toBe(
      'smtp.gmail.com',
    );
    expect((dialog().getByLabelText('Outgoing port') as HTMLInputElement).value).toBe('587');
    const security = dialog().getByLabelText('Security') as HTMLSelectElement;
    expect([...security.options].map((o) => o.text)).toEqual(['STARTTLS', 'SSL/TLS', 'None']);
    expect(security.value).toBe('starttls');
    const same = dialog().getByRole('checkbox', { name: 'Same login and password as incoming' });
    expect(same.getAttribute('aria-checked')).toBe('true');
    expect(dialog().queryByLabelText('Outgoing password')).toBeNull();

    // Back keeps what was typed.
    await user.click(dialog().getByRole('button', { name: 'Back' }));
    expect((dialog().getByLabelText('Incoming password') as HTMLInputElement).value).toBe(
      'abcd efgh ijkl mnop',
    );
    await next(user);
    await next(user);

    // Step 4: who answers.
    expect(stepText()).toBe('Step 4 of 4');
    const ai = dialog().getByRole('switch', { name: 'AI answers here' });
    expect(ai.getAttribute('aria-checked')).toBe('false');
    await user.click(ai);
    const team = dialog().getByRole('combobox', { name: 'Team' }) as HTMLSelectElement;
    expect([...team.options].map((o) => o.text)).toEqual(['No team (use routing)', 'Billing']);
    await user.selectOptions(team, 'team_billing');
    await user.click(dialog().getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(screen.queryByTestId('connect-email-dialog')).toBeNull());
    expect(gateway.to('POST', CONNECT).map((call) => call.body)).toEqual([
      {
        name: 'Support email',
        address: 'help@gmail.com',
        imap: {
          address: 'imap.gmail.com',
          port: 993,
          ssl: true,
          login: 'help@gmail.com',
          password: 'abcd efgh ijkl mnop',
        },
        smtp: {
          address: 'smtp.gmail.com',
          port: 587,
          security: 'starttls',
          login: 'help@gmail.com',
          password: 'abcd efgh ijkl mnop',
        },
        aiAnswers: true,
        defaultTeamId: 'team_billing',
      },
    ]);
    expect((await screen.findByTestId('channel-saved')).textContent).toBe(
      'Email connected. New emails will appear in your inbox.',
    );
    await waitFor(() =>
      expect(announced()).toBe('Email connected. New emails will appear in your inbox.'),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Support email' })).toBeTruthy();
    // Nothing of the mailbox is kept in the browser.
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('abcd');
  });

  it('sends the outgoing login and password when they are not the same', async () => {
    const gateway = emailGateway([]);
    await page([]);
    const user = userEvent.setup({ delay: null });
    await startConnect(user, 'help@noor.example');
    await user.selectOptions(dialog().getByLabelText('Email provider'), 'custom');
    await next(user);
    await user.type(dialog().getByLabelText('Incoming mail server'), 'mail.noor.example');
    await user.type(dialog().getByLabelText('Incoming password'), 'in-secret');
    await next(user);
    await user.type(dialog().getByLabelText('Outgoing mail server'), 'mail.noor.example');
    await user.clear(dialog().getByLabelText('Outgoing port'));
    await user.type(dialog().getByLabelText('Outgoing port'), '465');
    await user.selectOptions(dialog().getByLabelText('Security'), 'tls');
    await user.click(
      dialog().getByRole('checkbox', { name: 'Same login and password as incoming' }),
    );
    const login = dialog().getByLabelText('Outgoing login') as HTMLInputElement;
    expect(login.value).toBe('help@noor.example');
    await next(user);
    expect(dialog().getByText('Enter the password.')).toBeTruthy();
    await user.clear(login);
    await user.type(login, 'out@noor.example');
    await user.type(dialog().getByLabelText('Outgoing password'), 'out-secret');
    await next(user);
    await user.click(dialog().getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(gateway.to('POST', CONNECT)).toHaveLength(1));
    expect(gateway.to('POST', CONNECT)[0]?.body).toMatchObject({
      imap: { login: 'help@noor.example', password: 'in-secret' },
      smtp: {
        address: 'mail.noor.example',
        port: 465,
        security: 'tls',
        login: 'out@noor.example',
        password: 'out-secret',
      },
      aiAnswers: false,
      defaultTeamId: null,
    });
  });

  it('takes a refused password back to its step, next to the field, then connects', async () => {
    const gateway = emailGateway([channel()], {
      connect: (call) =>
        (call.body as { imap: { password: string } }).imap.password === 'wrong-password'
          ? {
              problem: {
                status: 422,
                code: 'VALIDATION_FAILED',
                fields: [
                  { path: 'imap.password', message: 'Error while connecting to the IMAP server' },
                ],
              },
            }
          : undefined,
    });
    await page([channel()]);
    const user = userEvent.setup({ delay: null });
    await startConnect(user, 'desk@fastmail.com');
    await next(user);
    await user.type(dialog().getByLabelText('Incoming password'), 'wrong-password');
    await next(user);
    await next(user);
    await user.click(dialog().getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(stepText()).toBe('Step 2 of 4'));
    const password = dialog().getByLabelText('Incoming password') as HTMLInputElement;
    expect(dialog().getByText('Error while connecting to the IMAP server')).toBeTruthy();
    expect(password.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect(dialog().getByTestId('action-error')).toBeTruthy();

    await user.clear(password);
    await user.type(password, 'right-password');
    expect(dialog().queryByText('Error while connecting to the IMAP server')).toBeNull();
    await next(user);
    await next(user);
    await user.click(dialog().getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.queryByTestId('connect-email-dialog')).toBeNull());
    expect(gateway.to('POST', CONNECT)).toHaveLength(2);
    expect(screen.getByTestId('channel-saved').textContent).toBe(
      'Email connected. New emails will appear in your inbox.',
    );
  });

  it('shows the gateway’s words when Chatwoot cannot be reached', async () => {
    const detail = 'Chatwoot did not answer. Nothing was connected.';
    emailGateway([], {
      connect: () => ({
        status: 503,
        json: { status: 503, code: 'AUTHORITY_UNAVAILABLE', title: 'Unavailable', detail },
      }),
    });
    await page([]);
    const user = userEvent.setup({ delay: null });
    await startConnect(user, 'help@gmail.com');
    await next(user);
    await user.type(dialog().getByLabelText('Incoming password'), 'secret');
    await next(user);
    await next(user);
    await user.click(dialog().getByRole('button', { name: 'Connect' }));
    const alert = await dialog().findByRole('alert');
    expect(within(alert).getByText('Chatwoot didn’t answer')).toBeTruthy();
    expect(within(alert).getByText(detail)).toBeTruthy();
    expect(stepText()).toBe('Step 4 of 4');
  });

  it('stops at Microsoft, which takes no passwords, until another provider is chosen', async () => {
    const gateway = emailGateway([]);
    await page([]);
    const user = userEvent.setup({ delay: null });
    await startConnect(user, 'shop@outlook.com');
    await next(user);
    expect(stepText()).toBe('Step 1 of 4');
    expect(
      dialog().getByText(
        'Microsoft no longer accepts passwords for email apps. Connect Outlook or Microsoft 365 in Chatwoot (Settings → Inboxes → Email → Microsoft), then use Check for new channels.',
      ),
    ).toBeTruthy();
    const provider = dialog().getByLabelText('Email provider') as HTMLSelectElement;
    expect(provider.value).toBe('microsoft');
    expect(dialog().getByText('Choose another provider to continue with a password.')).toBeTruthy();
    expect(document.activeElement).toBe(provider);
    expect(dialog().queryByTestId('app-password')).toBeNull();
    await next(user);
    expect(stepText()).toBe('Step 1 of 4');

    await user.selectOptions(provider, 'custom');
    expect(dialog().queryByTestId('microsoft-note')).toBeNull();
    await next(user);
    expect(stepText()).toBe('Step 2 of 4');
    expect(dialog().getByLabelText('Incoming password')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });

  it('asks before throwing input away, and forgets it all when closed', async () => {
    emailGateway([]);
    await page([]);
    const user = userEvent.setup({ delay: null });
    await startConnect(user, 'help@gmail.com');
    await next(user);
    await user.type(dialog().getByLabelText('Incoming password'), 'secret');
    await user.keyboard('{Escape}');
    const ask = await screen.findByTestId('discard-changes');
    expect(within(ask).getByText('Leave without saving?')).toBeTruthy();
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(stepText()).toBe('Step 2 of 4');
    expect((dialog().getByLabelText('Incoming password') as HTMLInputElement).value).toBe('secret');

    await user.click(dialog().getByRole('button', { name: 'Close' }));
    await user.click(
      within(await screen.findByTestId('discard-changes')).getByRole('button', {
        name: 'Discard changes',
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('connect-email-dialog')).toBeNull());

    await user.click(screen.getAllByRole('button', { name: 'Connect email' })[0] as HTMLElement);
    await screen.findByRole('dialog', { name: 'Connect email' });
    expect(stepText()).toBe('Step 1 of 4');
    expect((dialog().getByLabelText('Support address') as HTMLInputElement).value).toBe('');
    await user.type(dialog().getByLabelText('Support address'), 'help@gmail.com');
    await next(user);
    expect((dialog().getByLabelText('Incoming password') as HTMLInputElement).value).toBe('');
  });
});

describe('Email settings', () => {
  const settingsDialog = () => within(screen.getByTestId('email-settings-dialog'));

  it('loads the mailbox, keeps passwords unless changed, and says it saved', async () => {
    const gateway = emailGateway([channel()]);
    await page([channel()]);
    const user = userEvent.setup({ delay: null });
    const card = within(
      screen.getByRole('heading', { level: 2, name: 'Support email' }).closest('li') as HTMLElement,
    );
    expect(card.queryByRole('button', { name: /Fix sign-in/ })).toBeNull();
    await user.click(card.getByRole('button', { name: 'Email settings for Support email' }));
    await screen.findByRole('dialog', { name: 'Email settings' });
    expect(
      ((await settingsDialog().findByLabelText('Incoming mail server')) as HTMLInputElement).value,
    ).toBe('mail.noor.example');
    expect((settingsDialog().getByLabelText('Outgoing port') as HTMLInputElement).value).toBe(
      '587',
    );
    expect(settingsDialog().getByRole('group', { name: 'Incoming mail (IMAP)' })).toBeTruthy();
    expect(settingsDialog().getByRole('group', { name: 'Outgoing mail (SMTP)' })).toBeTruthy();
    expect(settingsDialog().queryByLabelText('Incoming password')).toBeNull();
    expect(settingsDialog().getAllByText('The password stays as it is.')).toHaveLength(2);

    await user.clear(settingsDialog().getByLabelText('Incoming port'));
    await user.type(settingsDialog().getByLabelText('Incoming port'), '143');
    await user.click(settingsDialog().getByRole('switch', { name: 'Use SSL' }));
    await user.click(settingsDialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('email-settings-dialog')).toBeNull());
    const [put] = gateway.to('PUT', SETTINGS);
    expect(put?.body).toEqual({
      name: 'Support email',
      address: 'help@noor.example',
      imap: { address: 'mail.noor.example', port: 143, ssl: false, login: 'help@noor.example' },
      smtp: {
        address: 'mail.noor.example',
        port: 587,
        security: 'starttls',
        login: 'help@noor.example',
      },
    });
    expect(card.getByTestId('channel-saved').textContent).toBe('Email settings saved.');
    await waitFor(() => expect(announced()).toBe('Email settings saved.'));

    // Changing the outgoing password sends that one only.
    await user.click(card.getByRole('button', { name: 'Email settings for Support email' }));
    await user.click(
      await settingsDialog().findByRole('button', { name: 'Change Outgoing password' }),
    );
    const smtpPassword = settingsDialog().getByLabelText('Outgoing password');
    expect(document.activeElement).toBe(smtpPassword);
    await user.click(settingsDialog().getByRole('button', { name: 'Save' }));
    expect(
      settingsDialog().getByText('Enter the new password, or keep the current one.'),
    ).toBeTruthy();
    await user.type(smtpPassword, 'new-smtp');
    await user.click(settingsDialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(gateway.to('PUT', SETTINGS)).toHaveLength(2));
    const second = gateway.to('PUT', SETTINGS)[1]?.body as {
      imap: Record<string, unknown>;
      smtp: Record<string, unknown>;
    };
    expect(second.imap).not.toHaveProperty('password');
    expect(second.smtp.password).toBe('new-smtp');
  });

  it('shows a refused field next to it', async () => {
    emailGateway([channel()], {
      save: () => ({
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'smtp.port', message: 'Chatwoot could not reach the SMTP server.' }],
        },
      }),
    });
    await page([channel()]);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: 'Email settings for Support email' }));
    await settingsDialog().findByLabelText('Outgoing port');
    await user.click(settingsDialog().getByRole('button', { name: 'Save' }));
    expect(
      await settingsDialog().findByText('Chatwoot could not reach the SMTP server.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(settingsDialog().getByLabelText('Outgoing port')),
    );
  });

  it('fixes the sign-in of a mailbox that needs attention with a new password', async () => {
    const gateway = emailGateway([
      channel({ status: 'needs_attention', problem: 'Chatwoot asks to sign in again' }),
    ]);
    await page([channel({ status: 'needs_attention', problem: 'Chatwoot asks to sign in again' })]);
    const user = userEvent.setup({ delay: null });
    expect(screen.getByText('Chatwoot says: Chatwoot asks to sign in again')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fix sign-in for Support email' }));
    await screen.findByRole('dialog', { name: 'Email settings' });
    const password = (await settingsDialog().findByLabelText(
      'Incoming password',
    )) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(password));
    expect(password.value).toBe('');
    expect(settingsDialog().getByTestId('fix-sign-in-hint')).toBeTruthy();
    expect(settingsDialog().queryByLabelText('Outgoing password')).toBeNull();
    await user.type(password, 'changed-password');
    await user.click(settingsDialog().getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('email-settings-dialog')).toBeNull());
    const body = gateway.to('PUT', SETTINGS)[0]?.body as {
      imap: Record<string, unknown>;
      smtp: Record<string, unknown>;
    };
    expect(body.imap.password).toBe('changed-password');
    expect(body.smtp).not.toHaveProperty('password');
    const card = within(
      screen.getByRole('heading', { level: 2, name: 'Support email' }).closest('li') as HTMLElement,
    );
    expect(await card.findByText('Connected')).toBeTruthy();
    expect(card.getByTestId('channel-saved').textContent).toBe('Email settings saved.');
    expect(card.queryByRole('button', { name: 'Fix sign-in for Support email' })).toBeNull();
  });
});
