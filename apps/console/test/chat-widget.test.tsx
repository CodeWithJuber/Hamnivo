// @vitest-environment jsdom
import { ConsentSettings, WidgetForms, WidgetSettings } from '@hamnivo/contracts';
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { keys } from '../src/lib/queries';
import { setupKeys } from '../src/lib/setup';
import { widgetFormKeys } from '../src/lib/widget-forms';
import { widgetSettingsKey } from '../src/pages/BrandChatSettings';
import { ChatWidgetPage } from '../src/pages/chat-widget/ChatWidgetPage';
import { fakeGateway, mountStudio, settle, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const developer = presetPermissions('developer');
const NOW = '2026-10-01T09:00:00.000Z';
const TEAM = 'team_01j9zk7w3xq8r4t2v6m5n1p0cd';

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
const appearance = {
  brandId: 'brd_1',
  appearance: {
    primaryColor: '#D17B00',
    logoUrl: null,
    radius: 12,
    greeting: null,
    offlineText: null,
    csat: false,
    privacyUrl: 'https://noor.example/privacy',
  },
  configVersion: 4,
  updatedAt: NOW,
};
const formsView = (forms = WidgetForms.parse({}), configVersion = 4) => ({
  brandId: 'brd_1',
  forms,
  configVersion,
  updatedAt: NOW,
});
const consentView = (consent = ConsentSettings.parse({}), noticeVersion = 0) => ({
  brandId: 'brd_1',
  consent,
  noticeVersion,
  configVersion: 4,
  updatedAt: null,
});
const linkView = (enabled: boolean, url: string | null = 'https://chat.example/c/wid_1') => ({
  brandId: 'brd_1',
  enabled,
  url,
  configVersion: 4,
  updatedAt: NOW,
});
const settingsView = { brandId: 'brd_1', settings: WidgetSettings.parse({}), configVersion: 4 };
const team = {
  id: TEAM,
  name: 'Billing',
  workspaceId: 'wsp_1',
  status: 'active',
  members: [],
  createdAt: NOW,
};

const put = (key: readonly unknown[], data: unknown) => (client: QueryClient) =>
  client.setQueryData([TENANT_ID, ...key], data);

/** Everything the page reads, already loaded; a test changes what it needs. */
const seed =
  (data: { forms?: unknown; consent?: unknown; link?: unknown; brands?: unknown[] } = {}) =>
  (client: QueryClient) => {
    for (const step of [
      put(keys.brands, { items: data.brands ?? [brand] }),
      put(keys.workspaces, { items: [workspace] }),
      put(setupKeys.appearance('brd_1'), appearance),
      put(widgetSettingsKey('brd_1'), settingsView),
      put(widgetFormKeys.forms('brd_1'), data.forms ?? formsView()),
      put(widgetFormKeys.consent('brd_1'), data.consent ?? consentView()),
      put(widgetFormKeys.directLink('brd_1'), data.link ?? linkView(true)),
      put(accessKeys.teams, { items: [team] }),
    ])
      step(client);
  };

const page = (
  at = '/chat-widget?brand=brd_1',
  permissions: readonly string[] = owner,
  data: Parameters<typeof seed>[0] = {},
) => mountStudio({ at, permissions, screen: <ChatWidgetPage />, seed: seed(data) });

/** The box that lists what has to be fixed, linking to each field. */
const errorSummary = async () => {
  await screen.findAllByRole('alert');
  const box = document.querySelector<HTMLElement>('[data-slot="form-error-summary"]');
  if (!box) throw new Error('no error summary on the page');
  return box;
};
const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id} on the page`);
  return element as T;
};

describe('the Chat widget page', () => {
  it('has a tab for each part of the chat, the look first, and keeps the tab in the address', async () => {
    fakeGateway({});
    const { router } = await page();
    expect(screen.getByRole('heading', { level: 1, name: 'Chat widget' })).toBeTruthy();
    const tabs = within(screen.getByRole('tablist', { name: 'Parts of the chat' }))
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(['Look', 'Behaviour', 'Forms', 'Privacy', 'Share']);
    expect(screen.getByRole('tab', { name: 'Look' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('appearance-form')).toBeTruthy();
    expect(screen.getByTestId('widget-preview')).toBeTruthy();

    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Forms' }));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ tab: 'forms' }));
    expect(router.state.location.search).toMatchObject({ brand: 'brd_1' });
    expect(await screen.findByTestId('forms-form')).toBeTruthy();
  });

  it('is there for a developer, who configures the widget without managing brands', async () => {
    fakeGateway({});
    await page('/chat-widget?tab=behaviour', developer);
    expect(screen.getByTestId('chat-settings-form')).toBeTruthy();
    // The brand comes from the workspace list; the picker shows only with two or more brands.
    expect(screen.getByRole('heading', { name: 'How the chat behaves' })).toBeTruthy();
  });

  it('says who can help when the person may not configure the chat widget', async () => {
    const gateway = fakeGateway({});
    await page('/chat-widget?tab=forms', presetPermissions('agent'));
    const denied = screen.getByTestId('forbidden');
    expect(within(denied).getByText('You can’t change the chat widget')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(gateway.calls.filter((call) => call.path.includes('widget-forms'))).toEqual([]);
  });

  it('offers to add a brand first when there is none', async () => {
    fakeGateway({});
    await page('/chat-widget', owner, { brands: [] });
    expect(screen.getByText('No brand yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Brands and install' })).toBeTruthy();
  });
});

describe('the Forms tab', () => {
  it('adds a question with answers to the pre-chat form and saves exactly what was set', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/widget-forms': (call) => ({
        json: formsView(call.body as never, 5),
      }),
    });
    await page('/chat-widget?brand=brd_1&tab=forms');
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('checkbox', { name: 'Ask these questions before a chat starts' }),
    );
    await user.click(
      within(screen.getByTestId('prechat-fields')).getByRole('button', { name: 'Add a question' }),
    );
    // The name is asked already, so the new question asks for an email address.
    const added = byId<HTMLSelectElement>('prechat-field-email-kind');
    expect(added.value).toBe('email');
    await waitFor(() => expect(document.activeElement).toBe(added));
    await user.selectOptions(added, 'choice');
    expect(byId<HTMLInputElement>('prechat-field-email-label-en').value).toBe('Choose one');
    await user.clear(byId('prechat-field-email-label-en'));
    await user.type(byId('prechat-field-email-label-en'), 'What is it about?');
    await user.type(byId('prechat-field-email-option-option-label-en'), 'An order');
    await user.type(byId('prechat-field-email-option-option-2-label-en'), 'A return');
    // Move it above the name: the new order is what is sent.
    await user.click(screen.getByRole('button', { name: 'Move What is it about? up' }));
    expect(
      within(screen.getByTestId('prechat-fields'))
        .getAllByTestId('prechat-field')
        .map((element) => element.getAttribute('data-field')),
    ).toEqual(['email', 'name']);
    // The picture shows the form as customers will see it.
    expect(screen.getByTestId('widget-preview').getAttribute('data-screen')).toBe('prechat');
    expect(screen.getAllByTestId('preview-field').map((element) => element.textContent)).toEqual([
      'What is it about?Choose…An orderA return',
      'Your name',
    ]);

    await user.click(screen.getByRole('button', { name: 'Save forms' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/widget-forms')).toHaveLength(1),
    );
    const sent = gateway.to('PUT', '/v1/admin/brands/brd_1/widget-forms')[0]?.body as {
      prechat: unknown;
      offline: unknown;
    };
    expect(sent.prechat).toEqual({
      enabled: true,
      skipVerified: true,
      fields: [
        {
          id: 'email',
          kind: 'choice',
          label: { en: 'What is it about?', ar: 'اختر واحدًا', hi: 'एक चुनें', ur: 'ایک منتخب کریں' },
          required: true,
          options: [
            { id: 'option', label: { en: 'An order' }, teamId: null },
            { id: 'option-2', label: { en: 'A return' }, teamId: null },
          ],
        },
        WidgetForms.parse({}).prechat.fields[0],
      ],
    });
    expect(sent.offline).toEqual(WidgetForms.parse({}).offline);
    // What the gateway returned is valid as the contract has it.
    expect(WidgetForms.safeParse(sent).success).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('forms-unsaved')).toBeNull());
  });

  it('says what is missing, by each field and in a summary, and sends nothing', async () => {
    const gateway = fakeGateway({});
    await page('/chat-widget?brand=brd_1&tab=forms');
    const user = userEvent.setup();
    const offline = screen.getByTestId('offline-fields');
    await user.click(within(offline).getByRole('button', { name: 'Add a question' }));
    await user.selectOptions(byId('offline-field-phone-kind'), 'department');
    await user.type(byId('offline-thanks-ar'), 'شكرًا');
    await user.click(screen.getByRole('button', { name: 'Save forms' }));
    const summary = await errorSummary();
    const messages = within(summary)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(messages).toEqual([
      'Contact form, question 4: choose the team for answer 1.',
      'Contact form, question 4: write answer 1 in English.',
      'Contact form, question 4: choose the team for answer 2.',
      'Contact form, question 4: write answer 2 in English.',
      'Write the thank-you message in English first. Other languages fall back to it.',
    ]);
    // Each message is also by its field, and the link puts focus on it.
    expect(byId('offline-field-phone-option-option-team').getAttribute('aria-invalid')).toBe(
      'true',
    );
    await user.click(within(summary).getAllByRole('link')[0] as HTMLElement);
    expect(document.activeElement?.id).toBe('offline-field-phone-option-option-team');
    expect(gateway.writes()).toEqual([]);
    // Choosing the team puts that one right at once.
    await user.selectOptions(byId('offline-field-phone-option-option-team'), TEAM);
    expect(byId('offline-field-phone-option-option-team').getAttribute('aria-invalid')).toBeNull();
  });

  it('keeps the contact form’s email and question, and says why', async () => {
    fakeGateway({});
    await page('/chat-widget?brand=brd_1&tab=forms');
    const required = byId<HTMLButtonElement>('offline-field-email-required');
    expect(required.getAttribute('data-state')).toBe('checked');
    expect(required.disabled).toBe(true);
    expect(
      screen.getByText(
        'Always asked and required: the answer reaches the customer at this address.',
      ),
    ).toBeTruthy();
    const remove = screen.getByRole('button', { name: 'Remove Your email' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText('The contact form can’t work without this question.').length).toBe(
      2,
    );
  });

  it('shows the gateway’s own reason by the field it is about', async () => {
    fakeGateway({
      'PUT /v1/admin/brands/brd_1/widget-forms': {
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'offline.fields.0.label.en', message: 'That word is not allowed.' }],
        },
      },
    });
    await page('/chat-widget?brand=brd_1&tab=forms');
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Let the AI assistant answer first' }));
    await user.click(screen.getByRole('button', { name: 'Save forms' }));
    const summary = await errorSummary();
    expect(within(summary).getByText('That word is not allowed.')).toBeTruthy();
    const name = byId('offline-field-name-label-en');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(byId('offline-field-name-label-en-error').textContent).toBe('That word is not allowed.');
  });
});

describe('the Privacy tab', () => {
  it('asks visitors from the EU, EEA and UK, with the brand’s own words', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/consent': (call) => ({
        json: consentView(call.body as never, 1),
      }),
    });
    await page('/chat-widget?brand=brd_1&tab=privacy');
    expect(screen.getByTestId('consent-version').textContent).toContain('Nobody has agreed yet');
    // Hamnivo's own words show, greyed, until the brand writes some; the picture shows them too.
    expect(byId<HTMLTextAreaElement>('consent-text-en').placeholder).toContain('We keep this chat');
    expect(screen.getByTestId('preview-consent').textContent).toContain('We keep this chat');
    expect(screen.getByTestId('consent-preview-notice')).toBeTruthy();
    // The privacy link is the one set on the Look tab, shown here to read, with a way there.
    expect(screen.getByTestId('consent-privacy-link').textContent).toContain(
      'https://noor.example/privacy',
    );
    expect(screen.getByTestId('consent-open-look').getAttribute('href')).toBe(
      '/chat-widget?brand=brd_1&tab=look',
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: 'Only visitors from the EU, EEA and UK' }));
    expect(
      screen.getByText(
        'We check where the connection comes from on each visit and never store it.',
      ),
    ).toBeTruthy();
    await user.type(byId('consent-text-en'), 'We keep this chat to help you.');
    expect(screen.getByTestId('consent-reconsent')).toBeTruthy();
    expect(screen.getByTestId('preview-consent').textContent).toBe(
      'We keep this chat to help you.',
    );
    await user.click(screen.getByRole('button', { name: 'Save consent settings' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/consent')).toHaveLength(1),
    );
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/consent')[0]?.body).toEqual({
      mode: 'eu',
      text: { en: 'We keep this chat to help you.' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('consent-version').textContent).toContain('version 1'),
    );
  });
});

describe('the Share tab', () => {
  it('shows the link to copy and open, and its QR code', async () => {
    fakeGateway({});
    await page('/chat-widget?brand=brd_1&tab=share');
    const url = 'https://chat.example/c/wid_1';
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Chat link' }).value).toBe(url);
    expect(screen.getByRole('textbox', { name: 'Chat link' }).hasAttribute('readonly')).toBe(true);
    const open = screen.getByRole('link', { name: 'Open the chat link in a new tab' });
    expect(open.getAttribute('href')).toBe(url);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
    const qr = screen.getByRole('img', { name: 'QR code that opens the chat of Noor Books' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByRole('button', { name: 'Download QR code' })).toBeTruthy();
    expect(
      screen.getByText('The link works even on websites that are not in your allowed list.'),
    ).toBeTruthy();
    // The install code is here too, for people who may read the brand.
    expect(screen.getByTestId('install-snippet').textContent).toContain('data-widget-id="wid_1"');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(await navigator.clipboard.readText()).toBe(url);
    expect(screen.getByTestId('copy-direct-link-status').textContent).toBe('Link copied');
  });

  it('turns the link on with Save, and only then shows it', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/direct-link': (call) => ({
        json: linkView(Boolean((call.body as { enabled: boolean }).enabled)),
      }),
    });
    await page('/chat-widget?brand=brd_1&tab=share', owner, { link: linkView(false) });
    expect(screen.getByTestId('direct-link-off').textContent).toContain('The link is off');
    expect(screen.getByTestId('direct-link-qr-off')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('checkbox', { name: 'Let people open the chat from a link' }),
    );
    // Nothing is changed until it is saved.
    expect(screen.queryByRole('textbox', { name: 'Chat link' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save link setting' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/direct-link')[0]?.body).toEqual({
        enabled: true,
      }),
    );
    expect(await screen.findByRole('textbox', { name: 'Chat link' })).toBeTruthy();
    expect(screen.getByTestId('direct-link-qr')).toBeTruthy();
  });

  it('says plainly when the server cannot make the link yet', async () => {
    fakeGateway({});
    await page('/chat-widget?brand=brd_1&tab=share', owner, { link: linkView(true, null) });
    expect(screen.getByTestId('direct-link-off').textContent).toContain(
      'this server doesn’t know the chat’s web address',
    );
    expect(screen.queryByTestId('direct-link-qr')).toBeNull();
  });

  it('points a developer to someone who can copy the install code', async () => {
    fakeGateway({});
    await page('/chat-widget?brand=brd_1&tab=share', developer);
    await settle();
    expect(screen.getByTestId('install-no-access').textContent).toContain(
      'Someone who manages brands can copy the install code',
    );
  });
});
