import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { identityKeysKey } from '../src/lib/identity';
import { keys } from '../src/lib/queries';
import { setupKeys } from '../src/lib/setup';
import { BrandsPage } from '../src/pages/BrandsPage';
import { ModelsPage } from '../src/pages/ModelsPage';
import { AddedBanner } from '../src/pages/models/AddedBanner';
import { ProbeResult, TestOutcome } from '../src/pages/models/ProbeResult';
import { OnboardingPage } from '../src/pages/onboarding/OnboardingPage';
import { AppearanceForm } from '../src/pages/settings/AppearanceDialog';
import { HoursPage } from '../src/pages/settings/HoursPage';
import { IdentityPage } from '../src/pages/settings/IdentityPage';
import { TeamsPage } from '../src/pages/settings/TeamsPage';
import { WidgetPreview } from '../src/pages/settings/WidgetPreview';
import { anchors, renderStudio, SELF_ID, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

// A page that makes the address of the test chat reads where Studio is; in Node there is no page.
afterEach(() => {
  vi.unstubAllGlobals();
});
const studioAt = (origin: string) =>
  vi.stubGlobal('window', { location: { origin } } as unknown as Window);

const owner = presetPermissions('owner');
const NOW = '2026-10-01T09:00:00.000Z';

// ------------------------------------------------------------------ fixtures

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
const hours = {
  timezone: 'Asia/Karachi',
  weekly: {
    sun: [],
    mon: [{ open: '09:00', close: '17:00' }],
    tue: [{ open: '09:00', close: '17:00' }],
    wed: [{ open: '09:00', close: '17:00' }],
    thu: [{ open: '09:00', close: '17:00' }],
    fri: [{ open: '09:00', close: '17:00' }],
    sat: [{ open: '10:00', close: '14:00' }],
  },
  closedDates: ['2026-12-25'],
};
const connection = {
  id: 'con_1',
  kind: 'chatwoot',
  baseUrl: 'https://chat.example.com',
  accountId: 7,
  status: 'active',
  inboxes: [{ id: 'inb_1', brandId: 'brd_1', purpose: 'live', externalInboxId: 1 }],
  createdAt: NOW,
};
const aiKey = (patch: Record<string, unknown> = {}) => ({
  id: 'mcn_1',
  provider: 'openai',
  label: 'OpenAI production',
  baseUrl: null,
  keyHint: 'a1b2',
  allowedModels: ['gpt-5.4-mini'],
  status: 'active',
  createdAt: NOW,
  ...patch,
});
const modelStatus = (patch: Record<string, unknown> = {}) => ({
  serverKeys: { anthropic: false, openai: false, google: false, openaiCompatible: false },
  jev: { configured: false },
  embeddings: { provider: 'mock', ready: true },
  tests: [],
  ...patch,
});
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

const seeded =
  (...steps: ((client: QueryClient) => void)[]) =>
  (client: QueryClient) => {
    for (const step of steps) step(client);
  };
const put = (key: readonly unknown[], data: unknown) => (client: QueryClient) =>
  client.setQueryData([TENANT_ID, ...key], data);

// ------------------------------------------------------------------ AI keys

const models = (...extra: ((client: QueryClient) => void)[]) =>
  renderStudio({
    at: '/models',
    permissions: owner,
    screen: <ModelsPage />,
    seed: seeded(...extra),
  });

describe('the AI keys page', () => {
  it('shows each key by its last characters only, with what its last test found', async () => {
    const html = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(
        setupKeys.modelStatus,
        modelStatus({
          tests: [
            {
              connectionId: 'mcn_1',
              ok: true,
              kind: 'ok',
              modelId: 'gpt-5.4-mini',
              testedAt: NOW,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('OpenAI production');
    expect(html).toMatch(/••••(?:<!-- -->)?a1b2/);
    expect(textOf(html)).toContain('Last test');
    const last = html.match(/data-testid="last-test"[^>]*>([\s\S]*?)<\/div>/);
    expect(textOf(last?.[1] ?? '')).toContain('Worked');
    expect(textOf(last?.[1] ?? '')).toContain('gpt-5.4-mini');
  });

  it('says why the last test failed, in plain words', async () => {
    const html = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(
        setupKeys.modelStatus,
        modelStatus({
          tests: [
            {
              connectionId: 'mcn_1',
              ok: false,
              kind: 'no_credit',
              modelId: 'gpt-5.4-mini',
              testedAt: NOW,
            },
          ],
        }),
      ),
    );
    expect(html).toContain('data-kind="no_credit"');
    expect(textOf(html)).toContain('No credit left');
  });

  it('offers Test key, Replace key and Disable on a key that is on, and nothing on one that is off', async () => {
    const html = await models(
      put(keys.modelConnections, {
        items: [aiKey(), aiKey({ id: 'mcn_2', label: 'Old key', status: 'disabled' })],
      }),
      put(setupKeys.modelStatus, modelStatus()),
    );
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toContain('Test the key of OpenAI production');
    expect(labels).toContain('Replace the key of OpenAI production');
    expect(labels).toContain('Disable OpenAI production');
    expect(labels.some((label) => label?.includes('Old key'))).toBe(false);
    expect(textOf(html)).toContain('Not tested yet');
  });

  it('shows which keys the server holds, as yes or no, and whether Jev is set up', async () => {
    const html = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(
        setupKeys.modelStatus,
        modelStatus({
          serverKeys: { anthropic: true, openai: false, google: false, openaiCompatible: false },
          jev: { configured: true },
        }),
      ),
    );
    const row = (id: string) =>
      html.match(new RegExp(`data-testid="${id}"[^>]*data-set="(\\w+)"`))?.[1];
    expect(row('server-key-anthropic')).toBe('yes');
    expect(row('server-key-openai')).toBe('no');
    expect(row('server-key-google')).toBe('no');
    expect(row('server-jev')).toBe('yes');
    expect(textOf(html)).toContain('Keys on this server');
  });

  it('says what searches the knowledge, and when its key is missing', async () => {
    const mock = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(setupKeys.modelStatus, modelStatus()),
    );
    expect(textOf(mock)).toContain('Basic word matching');
    const missing = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(setupKeys.modelStatus, modelStatus({ embeddings: { provider: 'openai', ready: false } })),
    );
    expect(textOf(missing)).toContain('Set to use OpenAI, but the server has no key for it.');
    const ready = await models(
      put(keys.modelConnections, { items: [aiKey()] }),
      put(setupKeys.modelStatus, modelStatus({ embeddings: { provider: 'google', ready: true } })),
    );
    expect(textOf(ready)).toContain('Searches by meaning using Google');
  });

  it('starts an empty page with what an AI key is for, and a way to add one', async () => {
    const html = await models(
      put(keys.modelConnections, { items: [] }),
      put(setupKeys.modelStatus, modelStatus()),
    );
    expect(textOf(html)).toContain('No model connections yet');
    expect(textOf(html)).toContain('Add your first AI key');
    expect(anchors(html).length).toBeGreaterThanOrEqual(0);
    expect(html).toContain('Add connection');
  });

  it('is not shown to someone who may not manage connections', async () => {
    const html = await renderStudio({
      at: '/models',
      permissions: presetPermissions('analyst'),
      screen: <ModelsPage />,
    });
    expect(html).toContain('data-testid="forbidden"');
    expect(html).not.toContain('Keys on this server');
  });
});

describe('what a key test found', () => {
  const result = (kind: Parameters<typeof ProbeResult>[0]['result']['kind']) =>
    renderStudio({
      at: '/models',
      permissions: owner,
      screen: <ProbeResult result={{ ok: kind === 'ok', kind, modelId: 'gpt-5.4-mini' }} />,
    });

  it('has plain words, and what to do, for every way it can end', async () => {
    const expected: Record<string, string> = {
      ok: 'The key works',
      wrong_key: 'The key wasn’t accepted',
      no_credit: 'No credit left',
      model_not_found: 'Model not found',
      network: 'Couldn’t reach the provider',
      blocked: 'That server address isn’t allowed',
      rate_limited: 'The provider says slow down',
      unavailable: 'The provider is having trouble',
      unknown: 'The test didn’t work',
    };
    for (const [kind, title] of Object.entries(expected)) {
      const html = await result(kind as Parameters<typeof result>[0]);
      expect(textOf(html), kind).toContain(title);
      expect(textOf(html), kind).toContain('Tested with gpt-5.4-mini');
      expect(html, kind).toContain(`data-kind="${kind}"`);
    }
  });

  it('shows a test that is running, then nothing until there is something to say', async () => {
    const running = await renderStudio({
      at: '/models',
      permissions: owner,
      screen: <TestOutcome pending result={null} error={null} modelId="gpt-5.4-mini" />,
    });
    expect(running).toContain('data-testid="probe-running"');
    expect(textOf(running)).toContain('Testing the key with gpt-5.4-mini…');
    const idle = await renderStudio({
      at: '/models',
      permissions: owner,
      screen: <TestOutcome pending={false} result={null} error={null} />,
    });
    expect(textOf(idle)).toBe('');
  });
});

describe('a key just saved', () => {
  it('says it was stored and starts the test, naming the model', async () => {
    const html = await renderStudio({
      at: '/models',
      permissions: owner,
      screen: (
        <AddedBanner
          connection={aiKey() as Parameters<typeof AddedBanner>[0]['connection']}
          modelId="gpt-5.4-mini"
          onReplace={() => undefined}
        />
      ),
    });
    expect(html).toContain('data-testid="connection-added"');
    expect(textOf(html)).toContain('won’t be shown again. It ends in a1b2.');
  });
});

// ------------------------------------------------------------------ brands

const brands = (extra: ((client: QueryClient) => void)[], permissions: readonly string[] = owner) =>
  renderStudio({
    at: '/brands',
    permissions,
    screen: <BrandsPage />,
    seed: seeded(...extra),
  });

describe('a brand’s card', () => {
  it('links to the chat widget, and has the test chat and the business hours', async () => {
    const html = await brands([
      put(keys.brands, { items: [{ ...brand, businessHours: hours }] }),
      put(keys.connections, { items: [connection] }),
    ]);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    // The look, behaviour, forms, consent and link of the chat are one page now, not dialogs.
    const widget = anchors(html).find((link) => link.attrs['data-testid'] === 'chat-widget-link');
    expect(widget?.href).toBe('/chat-widget?brand=brd_1');
    expect(widget?.attrs['aria-label']).toBe('Chat widget settings for Noor Books');
    expect(html).not.toContain('data-testid="appearance"');
    expect(html).not.toContain('data-testid="chat-settings"');
    expect(labels).toContain('Try the chat of Noor Books');
    const summary = html.match(/data-testid="hours-summary"[^>]*>([\s\S]*?)<\/div>\s*<a/);
    expect(textOf(summary?.[1] ?? '')).toContain('Mon to Fri 09:00 to 17:00');
    expect(textOf(summary?.[1] ?? '')).toContain('Sat 10:00 to 14:00');
    expect(textOf(summary?.[1] ?? '')).toContain('Asia/Karachi');
    expect(textOf(summary?.[1] ?? '')).toContain('Closed days: 1');
    const edit = anchors(html).find((link) => link.attrs['data-testid'] === 'edit-hours');
    expect(edit?.href).toBe('/hours?brand=brd_1');
  });

  it('lets the owner try the chat once the chat engine is connected', async () => {
    const html = await brands([
      put(keys.brands, { items: [brand] }),
      put(keys.connections, { items: [connection] }),
    ]);
    const button = html.match(/<button[^>]*data-testid="test-chat"[^>]*>/)?.[0] ?? '';
    expect(button).not.toContain('aria-disabled="true"');
    expect(html).not.toContain('Connect the chat engine for this brand first.');
  });

  it('says why the chat cannot be tried until the chat engine is connected', async () => {
    const html = await brands([
      put(keys.brands, { items: [brand] }),
      put(keys.connections, { items: [] }),
    ]);
    const button = html.match(/<button[^>]*data-testid="test-chat"[^>]*>/)?.[0] ?? '';
    expect(button).toContain('aria-disabled="true"');
    expect(textOf(html)).toContain('Connect the chat engine for this brand first.');
  });

  it('says that no hours are set, and that the chat then never claims a person is there', async () => {
    const html = await brands([
      put(keys.brands, { items: [brand] }),
      put(keys.connections, { items: [connection] }),
    ]);
    expect(textOf(html)).toContain(
      'Not set. Until you set hours, the chat never says a person is available.',
    );
  });

  it('keeps the look and the hours to people who may configure the chat', async () => {
    const html = await brands(
      [put(keys.brands, { items: [brand] }), put(keys.connections, { items: [connection] })],
      ['brands.manage', 'integrations.manage'],
    );
    expect(html).not.toContain('data-testid="chat-widget-link"');
    expect(html).not.toContain('data-testid="edit-hours"');
    expect(html).toContain('data-testid="test-chat"');
  });
});

// ------------------------------------------------------------------ how the chat looks

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
const look = (appearance: Record<string, unknown> = {}) =>
  renderStudio({
    at: '/brands',
    permissions: owner,
    screen: (
      <AppearanceForm
        brand={brand as Parameters<typeof AppearanceForm>[0]['brand']}
        view={view(appearance) as Parameters<typeof AppearanceForm>[0]['view']}
        onDirtyChange={() => undefined}
        onCancel={() => undefined}
        onSaved={() => undefined}
      />
    ),
  });

describe('the look and wording editor', () => {
  it('has a field for each thing a brand can change, and a picture of the chat', async () => {
    const html = await look();
    const text = textOf(html);
    for (const label of [
      'Main colour',
      'Logo web address',
      'Roundness of corners',
      'Greeting',
      'Message when nobody is online',
      'Ask customers to rate the chat',
      'Privacy policy web address',
    ]) {
      expect(text, label).toContain(label);
    }
    expect(html).toContain('data-testid="widget-preview"');
    expect(html).toMatch(/id="look-colour"[^>]*value="#D17B00"/);
  });

  it('shows Hamnivo’s greeting in the picture until the brand writes its own', async () => {
    const own = await look({ greeting: { en: 'Welcome to Noor Books!' } });
    expect(
      textOf(own.match(/data-testid="preview-greeting"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''),
    ).toBe('Welcome to Noor Books!');
    const initial = await look();
    expect(
      textOf(initial.match(/data-testid="preview-greeting"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''),
    ).toBe('Assalamu alaikum! How can we help today?');
  });

  it('draws the chat in the brand’s colour, with readable text on it', async () => {
    const html = await look({ primaryColor: '#0B5D3B', radius: 4 });
    const styleOf = (testId: string) => {
      const tag = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
      return tag.match(/style="([^"]*)"/)?.[1] ?? '';
    };
    const header = styleOf('preview-header');
    expect(header).toContain('background-color:#0B5D3B');
    expect(header).toContain('color:#FFFFFF');
    const panel = styleOf('widget-preview');
    // The design's 16 px corners at the default 12, scaled to the brand's 4.
    expect(panel).toContain('border-radius:5.3px');
  });

  it('suggests a colour that reads well when the one saved does not, and offers to use it', async () => {
    const html = await look({ primaryColor: '#808080' });
    expect(html).toContain('data-testid="colour-suggestion"');
    expect(textOf(html)).toContain('Text on this colour is hard to read.');
    const apply = [...html.matchAll(/<button[^>]*>\s*Use (#[0-9A-F]{6})\s*<\/button>/g)];
    expect(apply).toHaveLength(1);
  });

  it('shows the rating, the logo and the privacy link in the picture only when they are on', async () => {
    const off = await look();
    expect(off).not.toContain('data-testid="preview-csat"');
    expect(off).not.toContain('data-testid="preview-privacy"');
    const on = await look({
      csat: true,
      privacyUrl: 'https://noor.example/privacy',
      logoUrl: 'https://noor.example/logo.png',
    });
    expect(on).toContain('data-testid="preview-csat"');
    expect(on).toContain('data-testid="preview-privacy"');
    expect(on).toContain('src="https://noor.example/logo.png"');
    expect(on).toContain('referrerPolicy="no-referrer"');
  });
});

describe('the picture of the chat', () => {
  const draw = (patch: Partial<Parameters<typeof WidgetPreview>[0]['look']> = {}) =>
    renderStudio({
      at: '/brands',
      permissions: owner,
      screen: (
        <WidgetPreview
          look={{
            name: 'Noor Books',
            colour: '#D17B00',
            on: '#192A30',
            radius: 12,
            logoUrl: null,
            greeting: 'Hello!',
            away: 'We are away until Monday 9:00 AM.',
            showAway: false,
            csat: false,
            privacyUrl: null,
            lang: 'en',
            ...patch,
          }}
        />
      ),
    });

  it('shows the greeting, and the away message only when asked', async () => {
    const online = await draw();
    expect(textOf(online)).toContain('Hello!');
    expect(online).not.toContain('data-testid="preview-away"');
    const away = await draw({ showAway: true });
    expect(textOf(away)).toContain('We are away until Monday 9:00 AM.');
  });

  it('turns right to left for Arabic and Urdu, and speaks in the customer’s language', async () => {
    const arabic = await draw({ lang: 'ar', greeting: 'مرحبا' });
    expect(arabic).toContain('dir="rtl"');
    expect(arabic).toContain('lang="ar"');
    expect(textOf(arabic)).toContain('اكتب رسالة…');
    const hindi = await draw({ lang: 'hi' });
    expect(hindi).toContain('dir="ltr"');
    expect(textOf(hindi)).toContain('संदेश लिखें…');
  });

  it('draws a dark chat, a plain header and the launcher as they are chosen', async () => {
    const styleOf = (html: string, testId: string) => {
      const tag = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';
      return tag.match(/style="([^"]*)"/)?.[1] ?? '';
    };
    const light = await draw();
    expect(styleOf(light, 'widget-preview')).toContain('background-color:#FFFFFF');
    expect(light).not.toContain('data-testid="preview-launcher"');
    const dark = await draw({ theme: 'dark', launcherIcon: 'help', launcherSize: 'small' });
    expect(styleOf(dark, 'widget-preview')).toContain('background-color:#16242A');
    // On a dark chat the header is calm; the brand's colour stays on the launcher and buttons.
    expect(styleOf(dark, 'preview-header')).not.toContain('background-color:#D17B00');
    expect(styleOf(dark, 'preview-launcher')).toContain('background-color:#D17B00');
    expect(styleOf(dark, 'preview-launcher')).toContain('width:48px');
    expect(dark).toContain('data-icon="help"');
    const plain = await draw({ headerStyle: 'plain' });
    expect(styleOf(plain, 'preview-header')).toContain('background-color:#FFFFFF');
    expect(styleOf(plain, 'preview-header')).toContain('color:#192A30');
  });

  it('puts the brand name, and no logo picture when it has none', async () => {
    const html = await draw();
    expect(
      textOf(html.match(/data-testid="preview-header"[^>]*>([\s\S]*?)<\/header>/)?.[1] ?? ''),
    ).toBe('Noor Books');
    expect(html).not.toContain('<img');
  });
});

// ------------------------------------------------------------------ business hours

const hoursPage = (
  extra: ((client: QueryClient) => void)[],
  permissions: readonly string[] = owner,
  at = '/hours',
) => renderStudio({ at, permissions, screen: <HoursPage />, seed: seeded(...extra) });

describe('the business hours page', () => {
  const withHours = [put(keys.brands, { items: [{ ...brand, businessHours: hours }] })];

  it('shows the saved week, a day at a time, with its times', async () => {
    const html = await hoursPage(withHours);
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      expect(html, day).toContain(`data-testid="hours-day-${day}"`);
    }
    expect(html).toMatch(/id="hours-mon-0-open"[^>]*value="09:00"/);
    expect(html).toMatch(/id="hours-mon-0-close"[^>]*value="17:00"/);
    expect(html).toMatch(/id="hours-sat-0-open"[^>]*value="10:00"/);
    // Sunday is closed: no times to set.
    expect(html).not.toContain('id="hours-sun-0-open"');
  });

  it('shows the time zone and the days closed', async () => {
    const html = await hoursPage(withHours);
    expect(html).toMatch(/<option[^>]*value="Asia\/Karachi"[^>]*selected/);
    const closed = html.match(/data-testid="closed-dates"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
    expect(textOf(closed)).toContain('Friday, December 25, 2026');
    expect(html).toContain('aria-label="Remove Friday, December 25, 2026"');
  });

  it('offers quick starts, and removing the hours', async () => {
    const html = await hoursPage(withHours);
    const text = textOf(html);
    expect(text).toContain('Monday to Friday, 9:00 to 17:00');
    expect(text).toContain('Every day, all day');
    expect(text).toContain('Closed every day');
    expect(text).toContain('Remove hours');
  });

  it('starts empty for a brand with no hours, with nothing to remove and nothing to save yet', async () => {
    const html = await hoursPage([put(keys.brands, { items: [brand] })]);
    expect(html).not.toContain('id="hours-mon-0-open"');
    expect(textOf(html)).not.toContain('Remove hours');
    expect(textOf(html)).toContain('No days closed.');
    const save = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? '';
    expect(save).toContain('disabled');
  });

  it('opens the brand named in the address', async () => {
    const other = {
      ...brand,
      id: 'brd_2',
      name: 'Noor Toys',
      widgetId: 'wid_2',
      businessHours: hours,
    };
    const html = await hoursPage(
      [put(keys.brands, { items: [brand, other] })],
      owner,
      '/hours?brand=brd_2',
    );
    expect(html).toMatch(/<option[^>]*value="brd_2"[^>]*selected/);
    // The picked brand has hours; the other does not.
    expect(html).toContain('id="hours-mon-0-open"');
  });

  it('leaves the fields to someone who may not configure the chat, and says who can', async () => {
    const html = await hoursPage(withHours, ['brands.manage']);
    expect(html).toContain('<fieldset');
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(textOf(html)).toContain('Ask an owner or administrator to change business hours.');
  });

  it('sends someone with no brands to add one', async () => {
    const html = await hoursPage([put(keys.brands, { items: [] })]);
    expect(textOf(html)).toContain('Business hours belong to a brand. Add a brand first.');
    expect(anchors(html).find((link) => link.text === 'Go to brands')?.href).toBe('/brands');
  });
});

// ------------------------------------------------------------------ identity keys

const identity = (
  extra: ((client: QueryClient) => void)[],
  permissions: readonly string[] = owner,
) =>
  renderStudio({
    at: '/customer-identity',
    permissions,
    screen: <IdentityPage />,
    seed: seeded(put(keys.brands, { items: [brand] }), ...extra),
  });
const idKey = (patch: Record<string, unknown>) => ({
  kid: 'shop-1',
  alg: 'HS256',
  status: 'active',
  publicJwk: null,
  createdAt: NOW,
  retiredAt: null,
  ...patch,
});

describe('the customer sign-in page', () => {
  it('lists each key with what it is and where it stands', async () => {
    const html = await identity([
      put(identityKeysKey('brd_1'), {
        items: [
          idKey({}),
          idKey({ kid: 'shop-0', alg: 'ES256', status: 'retiring', retiredAt: NOW }),
          idKey({ kid: 'shop-old', status: 'revoked' }),
        ],
      }),
    ]);
    const row = (kid: string) =>
      textOf(html.match(new RegExp(`data-key="${kid}"[^>]*>([\\s\\S]*?)</tr>`))?.[1] ?? '');
    expect(row('shop-1')).toContain('Shared secret (HS256)');
    expect(row('shop-1')).toContain('Active');
    expect(row('shop-0')).toContain('Public key (ES256)');
    expect(row('shop-0')).toContain('Retiring');
    expect(row('shop-old')).toContain('Revoked');
  });

  it('offers Replace and Revoke on a key in use, Revoke on one retiring, and nothing on a revoked one', async () => {
    const html = await identity([
      put(identityKeysKey('brd_1'), {
        items: [
          idKey({}),
          idKey({ kid: 'shop-0', status: 'retiring', retiredAt: NOW }),
          idKey({ kid: 'shop-old', status: 'revoked' }),
        ],
      }),
    ]);
    const labels = [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toContain('Replace the key shop-1');
    expect(labels).toContain('Revoke the key shop-1');
    expect(labels).toContain('Revoke the key shop-0');
    expect(labels).not.toContain('Replace the key shop-0');
    expect(labels.some((label) => label?.includes('shop-old'))).toBe(false);
  });

  it('never shows a secret on the page, only what a key is called', async () => {
    const html = await identity([
      put(identityKeysKey('brd_1'), { items: [idKey({ secret: 'do-not-show-this-secret' })] }),
    ]);
    expect(html).not.toContain('do-not-show-this-secret');
  });

  it('starts empty with what a key is for, and says that a developer sets this up', async () => {
    const html = await identity([put(identityKeysKey('brd_1'), { items: [] })]);
    expect(textOf(html)).toContain('No keys yet');
    expect(textOf(html)).toContain('A developer sets this up');
    const guide = anchors(html).find((link) => link.text === 'Read the guide for developers');
    expect(guide?.href).toBe(
      'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guides/identity.md',
    );
    expect(guide?.attrs.rel).toBe('noopener noreferrer');
  });

  it('is shown only to someone who may manage the keys', async () => {
    const html = await identity([], ['brands.manage', 'members.read']);
    expect(html).toContain('data-testid="forbidden"');
  });

  it('explains how to change a key without locking customers out', async () => {
    const html = await identity([put(identityKeysKey('brd_1'), { items: [idKey({})] })]);
    expect(textOf(html)).toContain('Changing a key without a gap');
    expect(html.match(/<ol[^>]*>[\s\S]*?<\/ol>/)?.[0].match(/<li/g)).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ support teams

const teamsPage = (
  extra: ((client: QueryClient) => void)[],
  permissions: readonly string[] = owner,
) =>
  renderStudio({
    at: '/support-teams',
    permissions,
    screen: <TeamsPage />,
    seed: seeded(...extra),
  });
const team = (patch: Record<string, unknown> = {}) => ({
  id: 'team_1',
  name: 'Support',
  workspaceId: 'wsp_1',
  status: 'active',
  members: [{ staffMemberId: 'staff_a', displayName: 'Amina' }],
  createdAt: NOW,
  ...patch,
});
const people = [
  member('staff_a', 'Amina'),
  member('staff_b', 'Bilal'),
  member('staff_c', 'Chen', 'suspended'),
  member(SELF_ID, 'Omar'),
];

describe('the support teams page', () => {
  it('lists each team with its people, each with a button to take them out', async () => {
    const html = await teamsPage([
      put(accessKeys.teams, { items: [team()] }),
      put(keys.members, { items: people }),
    ]);
    expect(textOf(html)).toContain('Support');
    expect(textOf(html)).toContain('People in this team: 1');
    expect(html).toContain('aria-label="Take Amina out of Support"');
  });

  it('offers only active people who are not in the team yet', async () => {
    const html = await teamsPage([
      put(accessKeys.teams, { items: [team()] }),
      put(keys.members, { items: people }),
    ]);
    const select = html.match(/<select[^>]*id="team-team_1-add"[\s\S]*?<\/select>/)?.[0] ?? '';
    expect(select).toContain('Bilal');
    expect(select).toContain('Omar');
    expect(select).not.toContain('Amina');
    expect(select).not.toContain('Chen');
  });

  it('says so when everyone is in the team already', async () => {
    const html = await teamsPage([
      put(accessKeys.teams, {
        items: [team({ members: [{ staffMemberId: 'staff_a', displayName: 'Amina' }] })],
      }),
      put(keys.members, { items: [member('staff_a', 'Amina')] }),
    ]);
    expect(textOf(html)).toContain('Everyone is already in this team');
    expect(html).toMatch(/<select[^>]*id="team-team_1-add"[^>]*disabled/);
  });

  it('shows an empty team, and an archived team that cannot be changed', async () => {
    const html = await teamsPage([
      put(accessKeys.teams, {
        items: [
          team({ id: 'team_2', name: 'Sales', members: [] }),
          team({ id: 'team_3', name: 'Old team', status: 'archived' }),
        ],
      }),
      put(keys.members, { items: people }),
    ]);
    expect(textOf(html)).toContain('Nobody is in this team yet.');
    expect(textOf(html)).toContain('Archived');
    expect(html).not.toContain('id="team-team_3-add"');
    expect(html).not.toContain('aria-label="Take Amina out of Old team"');
  });

  it('leaves the teams as they are for someone who may not manage them', async () => {
    const html = await teamsPage(
      [put(accessKeys.teams, { items: [team()] }), put(keys.members, { items: people })],
      presetPermissions('supervisor'),
    );
    expect(textOf(html)).toContain('Support');
    expect(html).not.toContain('aria-label="Take Amina out of Support"');
    expect(html).not.toContain('id="team-team_1-add"');
    expect(textOf(html)).toContain('Ask an owner or administrator to change teams.');
  });

  it('starts an empty page with what a team is', async () => {
    const html = await teamsPage([
      put(accessKeys.teams, { items: [] }),
      put(keys.members, { items: people }),
    ]);
    expect(textOf(html)).toContain('No teams yet');
    expect(textOf(html)).toContain('such as “Support” or “Sales”');
  });
});

// ------------------------------------------------------------------ the guided setup

const progress = (steps: Record<string, 'done' | 'skipped'> = {}, patch = {}) => ({
  steps,
  brandId: null,
  finishedAt: null,
  updatedAt: null,
  ...patch,
});
const onboarding = (
  step: string | null,
  extra: ((client: QueryClient) => void)[],
  permissions: readonly string[] = owner,
) =>
  renderStudio({
    at: step ? `/onboarding?step=${step}` : '/onboarding',
    permissions,
    screen: <OnboardingPage />,
    seed: seeded(...extra),
  });
const workspaceLists = (patch: { brands?: unknown[]; connections?: unknown[] } = {}) => [
  put(keys.brands, { items: patch.brands ?? [] }),
  put(keys.connections, { items: patch.connections ?? [] }),
  put(keys.workspaces, {
    items: [{ id: 'wsp_1', name: 'Main', slug: 'main', status: 'active', brands: [] }],
  }),
  put(keys.members, { items: [member(SELF_ID, 'Omar')] }),
  put(accessKeys.invitations, { items: [] }),
  put(keys.modelConnections, { items: [] }),
  put(setupKeys.modelStatus, modelStatus()),
];

describe('the guided setup', () => {
  it('welcomes the owner, with seven steps in a list and a way to finish later', async () => {
    const html = await onboarding(null, [
      put(setupKeys.onboarding, progress()),
      ...workspaceLists(),
    ]);
    expect(textOf(html)).toContain('Welcome to Hamnivo');
    const steps = anchors(html).filter((link) => link.attrs['data-step']);
    // The rail lists them all, and the page shows the first.
    expect(steps.map((link) => link.attrs['data-step'])).toEqual([
      'workspace',
      'brand',
      'engine',
      'aikey',
      'testchat',
      'install',
      'team',
    ]);
    expect(anchors(html).find((link) => link.attrs['data-testid'] === 'finish-later')?.href).toBe(
      '/overview',
    );
    expect(html).toContain('data-step="workspace"');
  });

  it('opens at the first step not dealt with, and marks the ones that were', async () => {
    const html = await onboarding(null, [
      put(setupKeys.onboarding, progress({ workspace: 'done', brand: 'skipped' })),
      ...workspaceLists({ brands: [brand] }),
    ]);
    const title = html.match(/data-testid="onboarding-step-title"[^>]*>([\s\S]*?)<\/h2>/)?.[1];
    expect(textOf(title ?? '')).toBe('Connect the chat engine');
    const states = Object.fromEntries(
      anchors(html)
        .filter((link) => link.attrs['data-step'])
        .map((link) => [link.attrs['data-step'], link.attrs['data-state']]),
    );
    expect(states).toMatchObject({ workspace: 'done', brand: 'skipped', engine: 'todo' });
    expect(textOf(html)).toContain('2 of 7 steps dealt with');
    const current = anchors(html).filter((link) => link.attrs['aria-current'] === 'step');
    expect(current.map((link) => link.attrs['data-step'])).toEqual(['engine']);
  });

  it('shows the step in the address, and lets any step be skipped or gone back from', async () => {
    const html = await onboarding('aikey', [
      put(setupKeys.onboarding, progress()),
      ...workspaceLists(),
    ]);
    expect(html).toContain('data-step="aikey"');
    expect(textOf(html)).toContain('Step 4 of 7');
    expect(html).toContain('data-testid="onboarding-skip"');
    expect(textOf(html)).toContain('Back');
    const first = await onboarding('workspace', [
      put(setupKeys.onboarding, progress()),
      ...workspaceLists(),
    ]);
    // The first step has nothing to go back to.
    expect(textOf(first)).not.toContain('Back');
  });

  it('says the workspace is ready, by name', async () => {
    const html = await onboarding('workspace', [
      put(setupKeys.onboarding, progress()),
      ...workspaceLists(),
    ]);
    expect(textOf(html)).toContain('Your workspace Noor Books is ready.');
  });

  describe('the brand and website', () => {
    it('asks for a name and a website when there is no brand', async () => {
      const html = await onboarding('brand', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
      ]);
      expect(html).toContain('data-testid="onboarding-brand-form"');
      expect(textOf(html)).toContain('Brand name');
      expect(textOf(html)).toContain('Your website');
      expect(html).toContain('placeholder="https://northline.example"');
      expect(html).not.toContain('Use a brand I already have');
    });

    it('carries on with a brand that exists, and offers a different one', async () => {
      const html = await onboarding('brand', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists({ brands: [brand] }),
      ]);
      expect(html).toContain('data-testid="onboarding-brand-existing"');
      expect(textOf(html)).toContain('Continue with Noor Books');
      expect(textOf(html)).toContain('Add a different brand');
    });
  });

  describe('the chat engine', () => {
    it('is ready when the brand already has one', async () => {
      const html = await onboarding('engine', [
        put(setupKeys.onboarding, progress({}, { brandId: 'brd_1' })),
        ...workspaceLists({ brands: [brand], connections: [connection] }),
      ]);
      expect(html).toContain('data-testid="engine-ready"');
      expect(textOf(html)).toContain('Your chat engine is ready.');
    });

    it('sets itself up, saying what it makes, when the brand has none', async () => {
      const html = await onboarding('engine', [
        put(setupKeys.onboarding, progress({}, { brandId: 'brd_1' })),
        ...workspaceLists({ brands: [brand] }),
      ]);
      expect(html).toContain('data-testid="engine-working"');
      expect(textOf(html)).toContain('Setting up the chat engine for Noor Books.');
      expect(textOf(html)).toContain('Hamnivo sets up a Chatwoot account for this brand with:');
    });

    it('tells someone who may not connect it, instead of trying', async () => {
      const html = await onboarding(
        'engine',
        [put(setupKeys.onboarding, progress()), ...workspaceLists({ brands: [brand] })],
        ['brands.manage'],
      );
      expect(html).toContain('data-testid="engine-no-permission"');
      expect(html).not.toContain('data-testid="engine-working"');
    });

    it('needs a brand first', async () => {
      const html = await onboarding('engine', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
      ]);
      expect(html).toContain('data-testid="onboarding-needs-brand"');
      expect(textOf(html)).toContain('This step needs a brand. Add one first.');
    });
  });

  describe('the AI key', () => {
    it('asks for a key with the same form as the AI keys page', async () => {
      const html = await onboarding('aikey', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
      ]);
      expect(html).toContain('data-testid="onboarding-aikey"');
      expect(textOf(html)).toContain('Save and test');
      expect(html).toContain('id="mcn-apiKey"');
      expect(html.match(/<input[^>]*id="mcn-apiKey"[^>]*>/)?.[0]).toContain('type="password"');
      // gpt-5.4-mini is chosen for OpenAI.
      expect(html).toMatch(/<option[^>]*value="gpt-5.4-mini"[^>]*selected/);
    });

    it('tests a key that is already there instead of asking for another', async () => {
      const html = await onboarding('aikey', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
        put(keys.modelConnections, { items: [aiKey()] }),
      ]);
      expect(html).toContain('data-testid="aikey-existing"');
      expect(textOf(html)).toContain('You already have an AI key.');
      expect(textOf(html)).toContain('Ends in a1b2');
      expect(html).not.toContain('id="mcn-apiKey"');
    });

    it('tells a workspace whose server holds a key that it can answer without one', async () => {
      const html = await onboarding('aikey', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
        put(
          setupKeys.modelStatus,
          modelStatus({
            serverKeys: { anthropic: false, openai: true, google: false, openaiCompatible: false },
          }),
        ),
      ]);
      expect(html).toContain('data-testid="aikey-server-key"');
    });

    it('is left to people who manage connections', async () => {
      const html = await onboarding(
        'aikey',
        [put(setupKeys.onboarding, progress()), ...workspaceLists()],
        ['brands.manage'],
      );
      expect(html).toContain('data-testid="aikey-no-permission"');
      expect(html).not.toContain('id="mcn-apiKey"');
    });
  });

  describe('the test chat', () => {
    it('runs the real chat for the brand inside Studio, as a test', async () => {
      studioAt('https://studio.example');
      const html = await onboarding('testchat', [
        put(setupKeys.onboarding, progress({}, { brandId: 'brd_1' })),
        ...workspaceLists({ brands: [brand], connections: [connection] }),
      ]);
      const src = html.match(/<iframe[^>]*data-testid="test-chat-frame"/)
        ? (html.match(/<iframe[^>]*src="([^"]+)"/)?.[1] ?? '').replaceAll('&amp;', '&')
        : '';
      const url = new URL(src);
      expect(url.origin).toBe('http://localhost:5174');
      expect(url.searchParams.get('widgetId')).toBe('wid_1');
      expect(url.searchParams.get('test')).toBe('1');
      expect(url.searchParams.get('host')).toBe('https://studio.example');
      expect(html).toMatch(/<iframe[^>]*title="Test chat for Noor Books"/);
      expect(textOf(html)).toContain('Test chats are left out of your reports and counts.');
    });

    it('needs the chat engine, and points back to it', async () => {
      const html = await onboarding('testchat', [
        put(setupKeys.onboarding, progress({}, { brandId: 'brd_1' })),
        ...workspaceLists({ brands: [brand] }),
      ]);
      expect(html).toContain('data-testid="testchat-needs-engine"');
      expect(html).not.toContain('<iframe');
      const back = anchors(html).find((link) => link.text === 'Go to the chat engine step');
      expect(back?.href).toBe('/onboarding?step=engine');
    });
  });

  describe('installing the chat', () => {
    const install = (patch: Record<string, unknown> = {}, installs: unknown[] = []) =>
      onboarding('install', [
        put(setupKeys.onboarding, progress({}, { brandId: 'brd_1' })),
        put(keys.brandInstalls, { items: installs }),
        ...workspaceLists({ brands: [{ ...brand, ...patch }], connections: [connection] }),
      ]);

    it('offers every platform and links the guide for the one chosen', async () => {
      const html = await install();
      const start = html.indexOf('id="onb-platform"');
      const picker = html.slice(start, html.indexOf('</select>', start));
      const options = [...picker.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1]);
      expect(options).toEqual([
        'html',
        'wordpress',
        'woocommerce',
        'shopify',
        'whmcs',
        'wix',
        'squarespace',
        'webflow',
        'google-tag-manager',
        'react',
        'vue',
        'nextjs',
      ]);
      const guide = anchors(html).find((link) => link.attrs['data-testid'] === 'install-guide');
      expect(guide?.href).toBe(
        'https://github.com/CodeWithJuber/Hamnivo/blob/main/docs/guide/integrations/html.md',
      );
      expect(guide?.attrs.target).toBe('_blank');
      expect(guide?.attrs.rel).toBe('noopener noreferrer');
    });

    it('shows the brand’s code to copy, and the websites allowed to load it', async () => {
      const html = await install();
      expect(textOf(html)).toContain('data-widget-id="wid_1"');
      expect(textOf(html)).toContain('https://noor.example');
      expect(html).toContain('data-testid="copy-snippet"');
      expect(textOf(html)).toContain('Where does this code go?');
    });

    it('waits for the website, says what to do and how to check, and claims nothing (HNV-01-03)', async () => {
      const html = await install({}, []);
      const status = html.match(/data-testid="install-status"[\s\S]*?<\/section>/)?.[0] ?? '';
      expect(status).toContain('data-state="waiting"');
      expect(status).toContain('role="status"');
      expect(textOf(status)).toContain('Waiting for your website');
      expect(textOf(status)).toContain('then open any page of it');
      expect(status).toContain('data-testid="install-check"');
      expect(textOf(status)).toContain('Not showing up?');
      expect(textOf(status)).toContain('with the same https and www');
      expect(textOf(status)).toContain('content security policy');
      expect(textOf(html)).not.toContain('The chat is on your website');
    });

    it('says the chat is on the website once a page there loaded it, and where (HNV-01-04)', async () => {
      const html = await install({}, [
        {
          brandId: 'brd_1',
          origin: 'https://noor.example',
          firstSeenAt: new Date(Date.now() - 600_000).toISOString(),
          lastSeenAt: new Date(Date.now() - 120_000).toISOString(),
        },
      ]);
      const status = html.match(/data-testid="install-status"[\s\S]*?<\/section>/)?.[0] ?? '';
      expect(status).toContain('data-state="found"');
      expect(textOf(status)).toContain('The chat is on your website');
      expect(textOf(status)).toContain('https://noor.example');
      expect(textOf(status)).toContain('last seen 2 minutes ago');
      expect(status).not.toContain('data-testid="install-check"');
    });

    it('does not count another brand’s website', async () => {
      const html = await install({}, [
        {
          brandId: 'brd_other',
          origin: 'https://other.example',
          firstSeenAt: '2026-10-01T09:00:00.000Z',
          lastSeenAt: '2026-10-01T09:00:00.000Z',
        },
      ]);
      expect(html).toContain('data-state="waiting"');
      expect(textOf(html)).not.toContain('https://other.example');
    });

    it('warns when no website may load the chat yet, and links to where to add one', async () => {
      const html = await install({ allowedOrigins: [] });
      expect(html).toContain('data-testid="install-no-websites"');
      // There is nothing to wait for until a website is allowed.
      expect(html).not.toContain('data-testid="install-status"');
      const add = anchors(html).find((link) => link.text === 'Add your website');
      expect(add?.href).toBe('/brands#brand-brd_1');
    });
  });

  describe('the team', () => {
    it('counts the people already here and those invited', async () => {
      const html = await onboarding('team', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
        put(keys.members, { items: [member(SELF_ID, 'Omar'), member('staff_b', 'Bilal')] }),
        put(accessKeys.invitations, { items: [{ id: 'inv_1', status: 'pending' }] }),
      ]);
      expect(textOf(html)).toContain(
        'People in your workspace besides you: 1. Invitations sent: 1.',
      );
      expect(textOf(html)).toContain('Finish setup');
    });

    it('says nobody else is here yet, and that inviting is up to the owner', async () => {
      const html = await onboarding('team', [
        put(setupKeys.onboarding, progress()),
        ...workspaceLists(),
      ]);
      expect(textOf(html)).toContain('Nobody else is here yet.');
      const none = await onboarding(
        'team',
        [put(setupKeys.onboarding, progress()), ...workspaceLists()],
        ['brands.manage'],
      );
      expect(textOf(none)).toContain('Ask an owner or administrator to invite people.');
    });
  });

  describe('the end', () => {
    it('says the owner is all set when every step was done', async () => {
      const all = Object.fromEntries(
        ['workspace', 'brand', 'engine', 'aikey', 'testchat', 'install', 'team'].map((s) => [
          s,
          'done' as const,
        ]),
      );
      const html = await onboarding(null, [
        put(setupKeys.onboarding, progress(all)),
        ...workspaceLists(),
      ]);
      expect(html).toContain('data-testid="onboarding-finished"');
      expect(textOf(html)).toContain('You’re all set');
      expect(anchors(html).find((link) => link.text === 'Go to Overview')?.href).toBe('/overview');
    });

    it('lists the skipped steps with a way back into each', async () => {
      const html = await onboarding('finished', [
        put(
          setupKeys.onboarding,
          progress({ workspace: 'done', brand: 'skipped', engine: 'skipped' }),
        ),
        ...workspaceLists(),
      ]);
      expect(textOf(html)).toContain('Setup saved');
      expect(textOf(html)).toContain('Steps left: 6.');
      const back = anchors(html).filter((link) => link.text === 'Do it now');
      expect(back.map((link) => link.href)).toEqual([
        '/onboarding?step=brand',
        '/onboarding?step=engine',
        '/onboarding?step=aikey',
        '/onboarding?step=testchat',
        '/onboarding?step=install',
        '/onboarding?step=team',
      ]);
    });
  });

  it('is for people who manage brands', async () => {
    const html = await onboarding(null, [put(setupKeys.onboarding, progress())], ['members.read']);
    expect(html).toContain('data-testid="forbidden"');
  });
});
