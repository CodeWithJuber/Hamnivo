// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { identityKeysKey } from '../src/lib/identity';
import { keys } from '../src/lib/queries';
import { SettingsForm } from '../src/pages/BrandChatSettings';
import { AppearanceForm } from '../src/pages/settings/AppearanceDialog';
import { HoursPage } from '../src/pages/settings/HoursPage';
import { IdentityPage } from '../src/pages/settings/IdentityPage';
import { TeamsPage } from '../src/pages/settings/TeamsPage';
import { fakeGateway, mountStudio, SELF_ID, settle, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-01T09:00:00.000Z';

/** The box that lists what has to be fixed, linking to each field. */
const errorSummary = async () => {
  await screen.findAllByRole('alert');
  const box = document.querySelector<HTMLElement>('[data-slot="form-error-summary"]');
  if (!box) throw new Error('no error summary on the page');
  return box;
};
const put = (key: readonly unknown[], data: unknown) => (client: QueryClient) =>
  client.setQueryData([TENANT_ID, ...key], data);
const seeded =
  (...steps: ((client: QueryClient) => void)[]) =>
  (client: QueryClient) => {
    for (const step of steps) step(client);
  };

const brand = {
  id: 'brd_1',
  workspaceId: 'wsp_1',
  name: 'Noor Books',
  widgetId: 'wid_1',
  allowedOrigins: ['https://noor.example'],
  businessHours: null as unknown,
  status: 'active',
  createdAt: NOW,
};

// ------------------------------------------------------------------ the look and wording

const view = (appearance: Record<string, unknown> = {}) => ({
  brandId: 'brd_1',
  appearance: {
    primaryColor: '#D17B00',
    logoUrl: null,
    radius: 12,
    greeting: null,
    offlineText: null,
    csat: false,
    privacyUrl: null,
    ...appearance,
  },
  configVersion: 4,
  updatedAt: NOW,
});

// ------------------------------------------------------------------ how the chat behaves

describe('the chat settings', () => {
  const settings = (
    patch: { layout?: Record<string, unknown>; help?: Record<string, unknown> } = {},
  ) => ({
    layout: { mode: 'bubble', position: 'bottom-right', ...patch.layout },
    attachments: {
      enabled: true,
      allowedTypes: ['image/png', 'image/jpeg', 'application/pdf'],
      maxMegabytes: 10,
      maxFiles: 3,
    },
    help: { search: true, suggestions: [], ...patch.help },
    deletion: { windowMinutes: 15 },
    notifications: { email: true },
    handoff: { personButton: 'after_ai' },
  });
  const form = (initial = settings()) =>
    mountStudio({
      permissions: owner,
      screen: (
        <SettingsForm
          brand={brand as Parameters<typeof SettingsForm>[0]['brand']}
          initial={initial as Parameters<typeof SettingsForm>[0]['initial']}
        />
      ),
    });
  const saved = (gateway: ReturnType<typeof fakeGateway>) =>
    gateway.to('PUT', '/v1/admin/brands/brd_1/widget-settings')[0]?.body as Record<string, any>;

  it('moves the launcher, hides it on phones and turns next questions off, saving only that', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/widget-settings': {
        json: { brandId: 'brd_1', settings: settings(), configVersion: 5, updatedAt: NOW },
      },
    });
    await form();
    const user = userEvent.setup();
    expect(
      screen.getByRole('checkbox', { name: /Suggest next questions/ }).getAttribute('data-state'),
    ).toBe('checked');
    await user.type(screen.getByLabelText(/Space from the side/), '32');
    await user.click(screen.getByRole('checkbox', { name: /No button on phones/ }));
    await user.click(screen.getByRole('checkbox', { name: /Suggest next questions/ }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saved(gateway)).toBeDefined());
    expect(saved(gateway).layout).toEqual({
      mode: 'bubble',
      position: 'bottom-right',
      offset: { x: 32, y: 20 },
      hideOnMobile: true,
    });
    expect(saved(gateway).help).toEqual({ search: true, suggestions: [], followUps: false });
  });

  it('starts the "Talk to a person" button after the AI has tried, and saves another choice', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/widget-settings': {
        json: { brandId: 'brd_1', settings: settings(), configVersion: 5, updatedAt: NOW },
      },
    });
    await form();
    expect(
      screen.getByRole('radio', { name: /After the AI has tried/ }).getAttribute('data-state'),
    ).toBe('checked');
    const user = userEvent.setup();
    await user.click(screen.getByRole('radio', { name: /^Never/ }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saved(gateway)).toBeDefined());
    expect(saved(gateway).handoff).toEqual({ personButton: 'never' });
  });

  it('keeps what was saved before, and leaves the defaults out', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/widget-settings': {
        json: { brandId: 'brd_1', settings: settings(), configVersion: 5, updatedAt: NOW },
      },
    });
    await form(settings({ layout: { offset: { x: 0, y: 96 } }, help: { followUps: false } }));
    expect((screen.getByLabelText(/Space from the bottom/) as HTMLInputElement).value).toBe('96');
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: /Suggest next questions/ }));
    await user.clear(screen.getByLabelText(/Space from the side/));
    await user.clear(screen.getByLabelText(/Space from the bottom/));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saved(gateway)).toBeDefined());
    expect(saved(gateway).layout).toEqual({ mode: 'bubble', position: 'bottom-right' });
    expect(saved(gateway).help).toEqual({ search: true, suggestions: [] });
  });

  it('says what is wrong with a place off the screen, and sends nothing', async () => {
    const gateway = fakeGateway({});
    await form();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/Space from the bottom/), '900');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    const box = await errorSummary();
    expect(within(box).getByText('Enter a whole number from 0 to 400.')).toBeTruthy();
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/widget-settings')).toHaveLength(0);
  });
});

describe('the look and wording editor', () => {
  const editor = (
    appearance: Record<string, unknown> = {},
    handlers: {
      onDirtyChange?: (dirty: boolean) => void;
      onSaved?: () => void;
      onCancel?: () => void;
    } = {},
  ) =>
    mountStudio({
      permissions: owner,
      screen: (
        <AppearanceForm
          brand={brand as Parameters<typeof AppearanceForm>[0]['brand']}
          view={view(appearance) as Parameters<typeof AppearanceForm>[0]['view']}
          onDirtyChange={handlers.onDirtyChange ?? (() => undefined)}
          onCancel={handlers.onCancel ?? (() => undefined)}
          onSaved={handlers.onSaved ?? (() => undefined)}
        />
      ),
    });

  it('saves what was changed, and closes once it is saved', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/appearance/draft': { json: view({ radius: 4 }) },
    });
    const onSaved = vi.fn();
    await editor({}, { onSaved });
    fireEvent.change(screen.getByLabelText(/Roundness of corners/), { target: { value: '4' } });
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Logo web address', { exact: false }),
      'https://noor.example/logo.png',
    );
    await user.click(screen.getByRole('checkbox', { name: 'Ask customers to rate the chat' }));
    // Light or dark, the header and the launcher are drawn as they are chosen.
    await user.selectOptions(screen.getByLabelText('Light or dark', { exact: false }), 'dark');
    await user.selectOptions(screen.getByLabelText('Header'), 'plain');
    await user.selectOptions(screen.getByLabelText('Launcher picture'), 'sparkle');
    await user.selectOptions(screen.getByLabelText('Launcher size'), 'large');
    const panel = screen.getByTestId('widget-preview');
    expect(panel.getAttribute('data-theme')).toBe('dark');
    expect(panel.getAttribute('data-header')).toBe('plain');
    const launcher = screen.getByTestId('preview-launcher');
    expect(launcher.getAttribute('data-icon')).toBe('sparkle');
    expect(launcher.style.width).toBe('64px');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/appearance/draft')[0]?.body).toEqual({
      expectedRevision: 0,
      appearance: {
        fontFamily: 'system',
        launcherLabel: null,
        showBranding: true,
        primaryColor: '#D17B00',
        logoUrl: 'https://noor.example/logo.png',
        radius: 4,
        greeting: null,
        offlineText: null,
        csat: true,
        privacyUrl: null,
        theme: 'dark',
        headerStyle: 'plain',
        launcherIcon: 'sparkle',
        launcherSize: 'large',
      },
    });
  });

  it('publishes a saved draft only through the explicit publish action', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/brands/brd_1/appearance/publish': { json: view({ radius: 4 }) },
    });
    await mountStudio({
      permissions: owner,
      screen: (
        <AppearanceForm
          brand={brand}
          layout="page"
          view={
            {
              ...view(),
              draftAppearance: view({ radius: 4 }).appearance,
              draftRevision: 3,
            } as Parameters<typeof AppearanceForm>[0]['view']
          }
        />
      ),
    });
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/admin/brands/brd_1/appearance/publish')).toHaveLength(1),
    );
    expect(gateway.to('POST', '/v1/admin/brands/brd_1/appearance/publish')[0]?.body).toEqual({
      expectedRevision: 3,
    });
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/appearance')).toHaveLength(0);
  });

  it('draws the change in the picture as it is made, before anything is saved', async () => {
    const gateway = fakeGateway({});
    await editor();
    const panel = () => screen.getByTestId('widget-preview').getAttribute('style') ?? '';
    expect(panel()).toContain('border-radius: 16px');
    fireEvent.change(screen.getByLabelText(/Roundness of corners/), { target: { value: '0' } });
    expect(panel()).toContain('border-radius: 0px');
    const user = userEvent.setup();
    const greeting = screen.getByLabelText('English', { selector: '#look-greeting-en' });
    await user.type(greeting, 'Welcome to Noor Books!');
    expect(screen.getByTestId('preview-greeting').textContent).toBe('Welcome to Noor Books!');
    expect(gateway.calls).toEqual([]);
  });

  it('shows the picture in each language, and when the team is away', async () => {
    fakeGateway({});
    await editor({ offlineText: { en: 'We are closed. Back {when}.' } });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Language'), 'ar');
    const panel = screen.getByTestId('widget-preview');
    expect(panel.getAttribute('dir')).toBe('rtl');
    expect(screen.getByTestId('preview-greeting').textContent).toContain('السلام عليكم');
    await user.selectOptions(screen.getByLabelText('Language'), 'en');
    await user.selectOptions(screen.getByLabelText('Show when'), 'away');
    // {when} becomes a time people are back, in the language being previewed.
    expect(screen.getByTestId('preview-away').textContent).toMatch(/^We are closed\. Back .+\.$/);
    expect(screen.getByTestId('preview-away').textContent).not.toContain('{when}');
  });

  it('puts in a colour that reads well when it is offered, then saves it', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/appearance/draft': { json: view() },
    });
    const onSaved = vi.fn();
    await editor({ primaryColor: '#808080' }, { onSaved });
    expect(screen.getAllByText('Text on this colour is hard to read.').length).toBeGreaterThan(0);
    const user = userEvent.setup();
    const offer = screen.getByTestId('colour-suggestion');
    const apply = within(offer).getByRole('button');
    const colour = /Use (#[0-9A-F]{6})/.exec(apply.textContent ?? '')?.[1] ?? '';
    expect(colour).toMatch(/^#[0-9A-F]{6}$/);
    await user.click(apply);
    expect((document.getElementById('look-colour') as HTMLInputElement).value).toBe(colour);
    expect(screen.queryByText('Text on this colour is hard to read.')).toBeNull();
    expect(screen.queryByTestId('colour-suggestion')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect((gateway.calls[0]?.body?.appearance as Record<string, unknown>)?.primaryColor).toBe(
      colour,
    );
  });

  it('will not send a colour that cannot be read, and says why in a summary and by the field', async () => {
    const gateway = fakeGateway({});
    await editor({ primaryColor: '#F2F2F2' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const summary = await errorSummary();
    expect(within(summary).getByText(/too close to white/)).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });

  it('asks for English first, and for https addresses, before sending anything', async () => {
    const gateway = fakeGateway({});
    await editor({
      greeting: { en: '', ar: 'مرحبا' },
      logoUrl: 'http://noor.example/logo.png',
      privacyUrl: 'javascript:alert(1)',
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    const summary = await errorSummary();
    expect(within(summary).getByText(/Write the English text first/)).toBeTruthy();
    expect(within(summary).getAllByText(/https:\/\//).length).toBe(2);
    expect(gateway.writes()).toEqual([]);
  });

  it('shows the gateway’s own reason when it refuses what was sent', async () => {
    fakeGateway({
      'PUT /v1/admin/brands/brd_1/appearance/draft': {
        problem: {
          status: 422,
          code: 'VALIDATION_FAILED',
          fields: [{ path: 'primaryColor', message: 'The server does not like this colour.' }],
        },
      },
    });
    const onSaved = vi.fn();
    await editor({}, { onSaved });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      (await screen.findAllByText('The server does not like this colour.')).length,
    ).toBeGreaterThan(0);
    expect(onSaved).not.toHaveBeenCalled();
    // What was typed is still there to fix.
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
  });

  it('says when something is unsaved, and goes back to the saved look on Reset', async () => {
    fakeGateway({});
    const onDirtyChange = vi.fn();
    await editor({}, { onDirtyChange });
    const user = userEvent.setup();
    const reset = screen.getByRole('button', { name: 'Reset' }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Ask customers to rate the chat' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(reset.disabled).toBe(false);
    await user.click(reset);
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(
      screen
        .getByRole('checkbox', { name: 'Ask customers to rate the chat' })
        .getAttribute('data-state'),
    ).toBe('unchecked');
  });
});

// ------------------------------------------------------------------ business hours

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const hoursAnswer = (hours: unknown) => ({ json: { ...brand, businessHours: hours } });

describe('the business hours page', () => {
  const page = (
    businessHours: unknown = null,
    permissions: readonly string[] = owner,
    at = '/hours',
  ) =>
    mountStudio({
      at,
      permissions,
      screen: <HoursPage />,
      seed: seeded(put(keys.brands, { items: [{ ...brand, businessHours }] })),
    });
  const day = (name: string) => within(screen.getByTestId(`hours-day-${name}`));
  const timeOf = (id: string) =>
    (screen.getByLabelText(id, { selector: 'input' }) as HTMLInputElement).value;

  it('fills the week from a quick start and saves it in the brand’s time zone', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/business-hours': () => hoursAnswer({}),
      'GET /v1/admin/brands': { json: { items: [brand] } },
    });
    await page();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Monday to Friday, 9:00 to 17:00' }));
    expect(day('mon').getAllByLabelText('Opens')).toHaveLength(1);
    expect(day('sat').queryByLabelText('Opens')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')).toHaveLength(1),
    );
    const span = [{ open: '09:00', close: '17:00' }];
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')[0]?.body).toEqual({
      businessHours: {
        timezone: zone,
        weekly: { mon: span, tue: span, wed: span, thu: span, fri: span, sat: [], sun: [] },
        closedDates: [],
      },
    });
  });

  it('sends the end of a day as 24:00, and keeps lunch breaks as separate times', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/business-hours': () => hoursAnswer({}),
      'GET /v1/admin/brands': { json: { items: [brand] } },
    });
    await page();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Every day, all day' }));
    // A second time on Monday: open 09:00 to 13:00 and again 14:00 to 18:00.
    const mon = day('mon');
    fireEvent.change(mon.getByLabelText('Opens'), { target: { value: '09:00' } });
    fireEvent.change(mon.getByLabelText('Closes'), { target: { value: '13:00' } });
    await user.click(mon.getByRole('button', { name: 'Add another time' }));
    const opens = mon.getAllByLabelText('Opens');
    const closes = mon.getAllByLabelText('Closes');
    fireEvent.change(opens[1] as HTMLElement, { target: { value: '14:00' } });
    fireEvent.change(closes[1] as HTMLElement, { target: { value: '18:00' } });
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')).toHaveLength(1),
    );
    const sent = gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')[0]?.body as {
      businessHours: { weekly: Record<string, unknown> };
    };
    expect(sent.businessHours.weekly.mon).toEqual([
      { open: '09:00', close: '13:00' },
      { open: '14:00', close: '18:00' },
    ]);
    expect(sent.businessHours.weekly.tue).toEqual([{ open: '00:00', close: '24:00' }]);
  });

  it('adds and takes away whole days closed, in date order', async () => {
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/business-hours': () => hoursAnswer({}),
      'GET /v1/admin/brands': { json: { items: [brand] } },
    });
    await page();
    const user = userEvent.setup();
    const date = screen.getByLabelText('Day') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2026-12-25' } });
    await user.click(screen.getByRole('button', { name: 'Add day' }));
    fireEvent.change(date, { target: { value: '2026-08-14' } });
    await user.click(screen.getByRole('button', { name: 'Add day' }));
    const listed = within(screen.getByTestId('closed-dates')).getAllByRole('listitem');
    expect(listed.map((item) => item.textContent)).toEqual([
      expect.stringContaining('August 14, 2026'),
      expect.stringContaining('December 25, 2026'),
    ]);
    await user.click(screen.getByRole('button', { name: /^Remove .*August 14, 2026/ }));
    expect(within(screen.getByTestId('closed-dates')).getAllByRole('listitem')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')).toHaveLength(1),
    );
    const sent = gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')[0]?.body as {
      businessHours: { closedDates: string[] };
    };
    expect(sent.businessHours.closedDates).toEqual(['2026-12-25']);
  });

  it('says what to fix when times overlap or close before they open, and sends nothing', async () => {
    const gateway = fakeGateway({});
    await page();
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('hours-day-wed')).getByRole('checkbox'));
    const wed = day('wed');
    await user.click(wed.getByRole('button', { name: 'Add another time' }));
    fireEvent.change(wed.getAllByLabelText('Opens')[1] as HTMLElement, {
      target: { value: '16:00' },
    });
    fireEvent.change(wed.getAllByLabelText('Closes')[1] as HTMLElement, {
      target: { value: '20:00' },
    });
    await user.click(await screen.findByRole('button', { name: 'Save hours' }));
    const summary = await errorSummary();
    expect(within(summary).getByText('On Wednesday, the times must not overlap.')).toBeTruthy();
    // Closing before opening.
    fireEvent.change(wed.getAllByLabelText('Opens')[1] as HTMLElement, {
      target: { value: '21:00' },
    });
    await user.click(screen.getByRole('button', { name: 'Save hours' }));
    expect(await screen.findByText('On Wednesday, closing must be after opening.')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });

  it('shows what is saved, and takes the hours away after a confirmation', async () => {
    const week = { mon: [{ open: '09:00', close: '17:00' }] };
    const gateway = fakeGateway({
      'PUT /v1/admin/brands/brd_1/business-hours': () => hoursAnswer(null),
      'GET /v1/admin/brands': { json: { items: [brand] } },
    });
    await page({
      timezone: 'Asia/Karachi',
      weekly: { sun: [], mon: week.mon, tue: [], wed: [], thu: [], fri: [], sat: [] },
      closedDates: [],
    });
    expect(timeOf('Opens')).toBe('09:00');
    expect(timeOf('Closes')).toBe('17:00');
    expect((screen.getByLabelText('Time zone') as HTMLSelectElement).value).toBe('Asia/Karachi');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove hours' }));
    const dialog = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(within(dialog).getByText('Remove the hours of Noor Books?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remove hours' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')).toHaveLength(1),
    );
    expect(gateway.to('PUT', '/v1/admin/brands/brd_1/business-hours')[0]?.body).toEqual({
      businessHours: null,
    });
  });

  it('asks before leaving with times that are not saved, and lets the person stay', async () => {
    fakeGateway({});
    const { router } = await page();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Monday to Friday, 9:00 to 17:00' }));
    expect(screen.getByTestId('hours-unsaved')).toBeTruthy();
    void router.navigate({ to: '/brands' });
    const ask = await screen.findByTestId('discard-changes');
    expect(within(ask).getByText('Leave without saving?')).toBeTruthy();
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    await settle();
    expect(router.state.location.pathname).toBe('/hours');
    expect(screen.getByTestId('hours-unsaved')).toBeTruthy();
    // Leaving for real throws the changes away.
    void router.navigate({ to: '/brands' });
    const again = await screen.findByTestId('discard-changes');
    await user.click(within(again).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/brands'));
  });

  it('does not ask when nothing was changed', async () => {
    fakeGateway({});
    const { router } = await page();
    await router.navigate({ to: '/brands' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/brands'));
  });

  it('leaves the fields as they are for someone who may not change them', async () => {
    fakeGateway({});
    await page(null, ['brands.manage']);
    expect(
      (screen.getByTestId('hours-day-mon').closest('fieldset') as HTMLFieldSetElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Monday to Friday, 9:00 to 17:00' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText('Ask an owner or administrator to change business hours.'),
    ).toBeTruthy();
  });
});

// ------------------------------------------------------------------ support teams

describe('the support teams page', () => {
  const member = (id: string, displayName: string, status = 'active') => ({
    id,
    displayName,
    email: `${displayName.toLowerCase()}@example.com`,
    status,
    grants: [],
    teams: [],
    lastActiveAt: null,
    manageable: false,
  });
  const team = {
    id: 'team_1',
    name: 'Support',
    workspaceId: 'wsp_1',
    status: 'active',
    members: [{ staffMemberId: 'staff_a', displayName: 'Amina' }],
    createdAt: NOW,
  };
  const people = [member('staff_a', 'Amina'), member('staff_b', 'Bilal'), member(SELF_ID, 'Omar')];
  const mount = (permissions: readonly string[] = owner) =>
    mountStudio({
      permissions,
      screen: <TeamsPage />,
      seed: seeded(put(accessKeys.teams, { items: [team] }), put(keys.members, { items: people })),
    });
  const route = (members: string[]) => ({
    'PUT /v1/admin/teams/team_1/members': {
      json: { ...team, members: members.map((id) => ({ staffMemberId: id, displayName: id })) },
    },
    'GET /v1/admin/teams': { json: { items: [team] } },
    'GET /v1/admin/members': { json: { items: people } },
  });

  it('adds a person by sending the whole team with them in it', async () => {
    const gateway = fakeGateway(route(['staff_a', 'staff_b']));
    await mount();
    const user = userEvent.setup();
    const add = screen.getByRole('button', { name: 'Add to team' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Add a person'), 'staff_b');
    await user.click(add);
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/teams/team_1/members')).toHaveLength(1),
    );
    expect(gateway.writes()[0]?.body).toEqual({ staffMemberIds: ['staff_a', 'staff_b'] });
  });

  it('takes a person out by sending the team without them, even the last one', async () => {
    const gateway = fakeGateway(route([]));
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Take Amina out of Support' }));
    await waitFor(() =>
      expect(gateway.to('PUT', '/v1/admin/teams/team_1/members')).toHaveLength(1),
    );
    expect(gateway.writes()[0]?.body).toEqual({ staffMemberIds: [] });
  });

  it('keeps the team as it was and says why when the gateway refuses', async () => {
    fakeGateway({
      'PUT /v1/admin/teams/team_1/members': { problem: { status: 403, code: 'SCOPE_DENIED' } },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Take Amina out of Support' }));
    expect(await screen.findByTestId('action-error')).toBeTruthy();
    // Amina is still listed: the list changes only when the gateway has said yes.
    expect(within(screen.getByTestId('team-members')).getByText('Amina')).toBeTruthy();
  });
});

// ------------------------------------------------------------------ customer identity keys

describe('the customer sign-in page', () => {
  const key = (patch: Record<string, unknown> = {}) => ({
    kid: 'shop-1',
    alg: 'HS256',
    status: 'active',
    publicJwk: null,
    createdAt: NOW,
    retiredAt: null,
    ...patch,
  });
  const mount = (items: unknown[] = [key()]) =>
    mountStudio({
      at: '/customer-identity',
      permissions: owner,
      screen: <IdentityPage />,
      seed: seeded(put(keys.brands, { items: [brand] }), put(identityKeysKey('brd_1'), { items })),
    });
  const keysUrl = '/v1/admin/brands/brd_1/identity-keys';

  it('creates a shared secret, shows it once to copy, and then forgets it', async () => {
    const gateway = fakeGateway({
      [`POST ${keysUrl}`]: {
        status: 201,
        json: key({ kid: 'shop-2', secret: 's3cr3t-shown-once-0123456789' }),
      },
      [`GET ${keysUrl}`]: { json: { items: [key(), key({ kid: 'shop-2' })] } },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-identity-key'));
    const dialog = await screen.findByTestId('create-identity-key-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create secret' }));

    const reveal = await screen.findByTestId('identity-secret');
    expect(within(reveal).getByTestId('identity-secret-value').textContent).toBe(
      's3cr3t-shown-once-0123456789',
    );
    const [create] = gateway.to('POST', keysUrl);
    expect(create?.body).toEqual({ alg: 'HS256' });
    expect(create?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // Done: the secret leaves the page, and the list never had it.
    await user.click(within(reveal).getByTestId('identity-secret-done'));
    await waitFor(() => expect(screen.queryByTestId('identity-secret')).toBeNull());
    expect(document.body.textContent).not.toContain('s3cr3t-shown-once-0123456789');
    await waitFor(() =>
      expect(screen.getByTestId('identity-keys-table').textContent).toContain('shop-2'),
    );
  });

  it('replaces a key with a new one of the same kind, and marks the old one as retiring', async () => {
    const gateway = fakeGateway({
      [`POST ${keysUrl}`]: {
        status: 201,
        json: key({ kid: 'shop-2', secret: 'another-secret-value-1234' }),
      },
      [`POST ${keysUrl}/shop-1/retire`]: { json: key({ status: 'retiring' }) },
      [`GET ${keysUrl}`]: {
        json: { items: [key({ status: 'retiring' }), key({ kid: 'shop-2' })] },
      },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace the key shop-1' }));
    const dialog = await screen.findByTestId('create-identity-key-dialog');
    // The kind is the old key's: there is no choice to make.
    expect(within(dialog).queryByRole('radio')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Create secret' }));
    expect(await screen.findByTestId('identity-secret')).toBeTruthy();
    expect(gateway.writes().map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST ${keysUrl}`,
      `POST ${keysUrl}/shop-1/retire`,
    ]);
    expect(screen.queryByText(/could not be marked as retiring/)).toBeNull();
  });

  it('shows the new secret even when the old key could not be marked, and says what to do', async () => {
    fakeGateway({
      [`POST ${keysUrl}`]: {
        status: 201,
        json: key({ kid: 'shop-2', secret: 'another-secret-value-1234' }),
      },
      [`POST ${keysUrl}/shop-1/retire`]: { problem: { status: 500, code: 'INTERNAL' } },
      [`GET ${keysUrl}`]: { json: { items: [key(), key({ kid: 'shop-2' })] } },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Replace the key shop-1' }));
    const dialog = await screen.findByTestId('create-identity-key-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Create secret' }));
    expect(await screen.findByTestId('identity-secret-value')).toBeTruthy();
    expect(await screen.findByText(/shop-1 could not be marked as retiring/)).toBeTruthy();
  });

  it('registers a public key, and refuses a private one before sending anything', async () => {
    const gateway = fakeGateway({
      [`POST ${keysUrl}`]: { status: 201, json: key({ kid: 'pub-1', alg: 'ES256' }) },
      [`GET ${keysUrl}`]: { json: { items: [key(), key({ kid: 'pub-1', alg: 'ES256' })] } },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('create-identity-key'));
    const dialog = await screen.findByTestId('create-identity-key-dialog');
    await user.click(within(dialog).getByRole('radio', { name: /A public key/ }));
    const box = within(dialog).getByLabelText('Public key (JWK)');
    fireEvent.change(box, {
      target: { value: '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"secret"}' },
    });
    await user.click(within(dialog).getByRole('button', { name: 'Register key' }));
    expect((await within(dialog).findAllByText(/looks like a private key/)).length).toBeGreaterThan(
      0,
    );
    expect(gateway.writes()).toEqual([]);

    fireEvent.change(box, { target: { value: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}' } });
    await user.type(within(dialog).getByLabelText('Key name', { exact: false }), 'pub-1');
    await user.click(within(dialog).getByRole('button', { name: 'Register key' }));
    await waitFor(() => expect(gateway.to('POST', keysUrl)).toHaveLength(1));
    expect(gateway.writes()[0]?.body).toEqual({
      alg: 'ES256',
      kid: 'pub-1',
      publicJwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    });
    // A public key has no secret to show.
    await waitFor(() => expect(screen.queryByTestId('create-identity-key-dialog')).toBeNull());
    expect(screen.queryByTestId('identity-secret')).toBeNull();
  });

  it('revokes a key only after asking', async () => {
    const gateway = fakeGateway({
      [`POST ${keysUrl}/shop-1/revoke`]: { json: key({ status: 'revoked' }) },
      [`GET ${keysUrl}`]: { json: { items: [key({ status: 'revoked' })] } },
    });
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Revoke the key shop-1' }));
    const dialog = await screen.findByTestId('revoke-identity-key-dialog');
    expect(within(dialog).getByText('Revoke the key shop-1?')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke key' }));
    await waitFor(() => expect(gateway.to('POST', `${keysUrl}/shop-1/revoke`)).toHaveLength(1));
  });
});
