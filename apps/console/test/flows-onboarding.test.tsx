// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { keys } from '../src/lib/queries';
import { setupKeys } from '../src/lib/setup';
import type { Brand } from '../src/lib/types';
import { AiKeyStep } from '../src/pages/onboarding/AiKeyStep';
import { BrandStep } from '../src/pages/onboarding/BrandStep';
import { EngineStep } from '../src/pages/onboarding/EngineStep';
import { OnboardingPage } from '../src/pages/onboarding/OnboardingPage';
import { fakeGateway, mountStudio, SELF_ID, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const owner = presetPermissions('owner');
const NOW = '2026-10-01T09:00:00.000Z';
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
  businessHours: null,
  status: 'active',
  createdAt: NOW,
} as Brand;
const workspaces = {
  items: [{ id: 'wsp_1', name: 'Main', slug: 'main', status: 'active', brands: [] }],
};
const chatEngine = (status = 'active') => ({
  id: 'con_1',
  kind: 'chatwoot',
  baseUrl: 'https://chat.example.com',
  accountId: 7,
  status,
  inboxes: [{ id: 'inb_1', brandId: 'brd_1', purpose: 'live', externalInboxId: 1 }],
  createdAt: NOW,
});

// ------------------------------------------------------------------ the brand and website

describe('the brand and website step', () => {
  const step = (
    onDone: (id: string) => void = () => undefined,
    brands: Brand[] = [],
    onChoose: (id: string) => void = () => undefined,
  ) =>
    mountStudio({
      permissions: owner,
      screen: (
        <BrandStep brands={brands} chosenId={brands[0]?.id} onChoose={onChoose} onDone={onDone} />
      ),
      seed: seeded(put(keys.workspaces, workspaces)),
    });
  const created = { ...brand, id: 'brd_new', name: 'Northline', allowedOrigins: [] };

  it('makes the brand with its website as the one address allowed to load the chat', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/brands': { status: 201, json: created },
      'GET /v1/admin/brands': { json: { items: [created] } },
      'GET /v1/admin/workspaces': { json: workspaces },
    });
    const onDone = vi.fn();
    await step(onDone);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Brand name'), 'Northline');
    await user.type(screen.getByLabelText(/Your website/), 'https://northline.example/shop?ref=1');
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('brd_new'));
    const [call] = gateway.to('POST', '/v1/admin/brands');
    expect(call?.body).toEqual({
      workspaceId: 'wsp_1',
      name: 'Northline',
      allowedOrigins: ['https://northline.example'],
    });
    expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes a bare domain, and lets the website wait', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/brands': { status: 201, json: created },
      'GET /v1/admin/brands': { json: { items: [created] } },
    });
    const onDone = vi.fn();
    await step(onDone);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Brand name'), 'Northline');
    await user.type(screen.getByLabelText(/Your website/), 'northline.example');
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(gateway.to('POST', '/v1/admin/brands')[0]?.body?.allowedOrigins).toEqual([
      'https://northline.example',
    ]);
  });

  it('sends no website at all when none was given', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/brands': { status: 201, json: created },
      'GET /v1/admin/brands': { json: { items: [created] } },
    });
    const onDone = vi.fn();
    await step(onDone);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Brand name'), 'Northline');
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(gateway.to('POST', '/v1/admin/brands')[0]?.body?.allowedOrigins).toEqual([]);
  });

  it('asks for a name, and says what in the website cannot be read, before sending anything', async () => {
    const gateway = fakeGateway({});
    await step();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    expect((await screen.findAllByText('Enter a brand name.')).length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('Brand name'), 'Northline');
    await user.type(screen.getByLabelText(/Your website/), 'not a website');
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    expect(
      (await screen.findAllByText(/not a website isn’t a website address/)).length,
    ).toBeGreaterThan(0);
    expect(gateway.writes()).toEqual([]);
  });

  it('carries on with a brand that exists, or turns to making a new one', async () => {
    fakeGateway({});
    const onDone = vi.fn();
    await step(onDone, [brand]);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue with Noor Books' }));
    expect(onDone).toHaveBeenCalledWith('brd_1');
    await user.click(screen.getByRole('button', { name: 'Add a different brand' }));
    expect(screen.getByLabelText('Brand name')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Use a brand I already have' }));
    expect(screen.getByTestId('onboarding-brand-existing')).toBeTruthy();
  });
});

// ------------------------------------------------------------------ the chat engine

describe('the chat engine step', () => {
  const engine = (onDone: () => void = () => undefined, permissions: readonly string[] = owner) =>
    mountStudio({
      permissions,
      screen: <EngineStep brand={brand} onDone={onDone} />,
      seed: seeded(put(keys.connections, { items: [] })),
    });

  it('sets itself up for the brand, once, and says when it is ready', async () => {
    let listed: unknown[] = [];
    const gateway = fakeGateway({
      'POST /v1/admin/authority/connections': () => {
        listed = [chatEngine()];
        return { status: 201, json: chatEngine() };
      },
      'GET /v1/admin/authority/connections': () => ({ json: { items: listed } }),
      'GET /v1/admin/agents': { json: { items: [] } },
    });
    const onDone = vi.fn();
    await engine(onDone);
    expect(await screen.findByTestId('engine-ready')).toBeTruthy();
    expect(screen.getByText('Your chat engine is ready.')).toBeTruthy();
    const posts = gateway.to('POST', '/v1/admin/authority/connections');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ brandId: 'brd_1' });
    expect(posts[0]?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('tries again with a new key when it could not finish, so it is not taken for the first try', async () => {
    let attempt = 0;
    const gateway = fakeGateway({
      'POST /v1/admin/authority/connections': () =>
        ++attempt === 1
          ? { problem: { status: 503, code: 'UPSTREAM_UNAVAILABLE' } }
          : { status: 201, json: chatEngine() },
      'GET /v1/admin/authority/connections': () => ({
        json: { items: attempt > 1 ? [chatEngine()] : [] },
      }),
      'GET /v1/admin/agents': { json: { items: [] } },
    });
    await engine();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByTestId('action-error')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(retry);
    expect(await screen.findByTestId('engine-ready')).toBeTruthy();
    const [first, second] = gateway.to('POST', '/v1/admin/authority/connections');
    expect(second?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.headers['idempotency-key']).not.toBe(first?.headers['idempotency-key']);
  });

  it('does not start anything for someone who may not connect it', async () => {
    const gateway = fakeGateway({});
    await engine(undefined, ['brands.manage']);
    expect(await screen.findByTestId('engine-no-permission')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });

  it('does not make a second one when the brand already has a chat engine', async () => {
    const gateway = fakeGateway({});
    await mountStudio({
      permissions: owner,
      screen: <EngineStep brand={brand} onDone={() => undefined} />,
      seed: seeded(put(keys.connections, { items: [chatEngine()] })),
    });
    expect(await screen.findByTestId('engine-ready')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });

  const setupRecord = (state: string, lastError: string | null = null) => ({
    brandId: 'brd_1',
    state,
    step: 'account_user',
    attempts: 1,
    lastError,
    updatedAt: NOW,
    finishedAt: null,
  });

  it('shows how far the set-up got while another attempt is running it', async () => {
    fakeGateway({
      'POST /v1/admin/authority/connections': {
        problem: { status: 409, code: 'VERSION_CONFLICT' },
      },
      'GET /v1/admin/authority/connections': { json: { items: [] } },
      'GET /v1/admin/authority/provisioning': { json: { items: [setupRecord('running')] } },
    });
    await engine();
    expect(await screen.findByText('Setting up chat: creating the inbox')).toBeTruthy();
    expect(screen.getByTestId('engine-working')).toBeTruthy();
    expect(screen.queryByTestId('engine-stopped')).toBeNull();
  });

  it('says why the set-up stopped, and trying again carries it on', async () => {
    let attempt = 0;
    const gateway = fakeGateway({
      'POST /v1/admin/authority/connections': () =>
        ++attempt === 1
          ? { problem: { status: 503, code: 'AUTHORITY_UNAVAILABLE' } }
          : { status: 201, json: chatEngine() },
      'GET /v1/admin/authority/connections': () => ({
        json: { items: attempt > 1 ? [chatEngine()] : [] },
      }),
      'GET /v1/admin/authority/provisioning': () => ({
        json: {
          items: attempt > 1 ? [] : [setupRecord('failed', 'Chatwoot inbox failed (HTTP 500).')],
        },
      }),
      'GET /v1/admin/agents': { json: { items: [] } },
    });
    await engine();
    expect(await screen.findByTestId('engine-reason')).toBeTruthy();
    expect(
      screen.getByText(/The set-up stopped: Chatwoot inbox failed \(HTTP 500\)\./),
    ).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('engine-ready')).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/authority/connections')).toHaveLength(2);
  });

  it('says when the set-up takes longer than usual, and that the step can be skipped', async () => {
    fakeGateway({ 'GET /v1/admin/authority/connections': { json: { items: [] } } });
    const answer = globalThis.fetch;
    // The request to set it up does not come back.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' ? new Promise<Response>(() => undefined) : answer(input, init),
    );
    await mountStudio({
      permissions: owner,
      screen: <EngineStep brand={brand} onDone={() => undefined} slowAfterMs={20} />,
      seed: seeded(put(keys.connections, { items: [] })),
    });
    expect(await screen.findByTestId('engine-slow')).toBeTruthy();
    expect(screen.getByText(/taking longer than usual/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('asks for a fresh sign-in instead of spinning when the list needs one', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/authority/connections': {
        problem: { status: 401, code: 'REAUTH_REQUIRED' },
      },
    });
    await mountStudio({
      permissions: owner,
      screen: <EngineStep brand={brand} onDone={() => undefined} />,
    });
    expect(await screen.findByText('Sign in again to continue')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(screen.queryByTestId('engine-working')).toBeNull();
    expect(gateway.writes()).toEqual([]);
  });

  it('says so when the connection is turned off, and does not set up another', async () => {
    const gateway = fakeGateway({});
    await mountStudio({
      permissions: owner,
      screen: <EngineStep brand={brand} onDone={() => undefined} />,
      seed: seeded(put(keys.connections, { items: [chatEngine('disabled')] })),
    });
    expect(await screen.findByTestId('engine-disabled')).toBeTruthy();
    expect(gateway.writes()).toEqual([]);
  });
});

// ------------------------------------------------------------------ the AI key

describe('the AI key step', () => {
  const key = (patch: Record<string, unknown> = {}) => ({
    id: 'mcn_1',
    provider: 'openai',
    label: 'OpenAI',
    baseUrl: null,
    keyHint: 'a1b2',
    allowedModels: [],
    status: 'active',
    createdAt: NOW,
    ...patch,
  });
  const status = {
    serverKeys: { anthropic: false, openai: false, google: false, openaiCompatible: false },
    jev: { configured: false },
    embeddings: { provider: 'mock', ready: true },
    tests: [],
  };
  const outcome = (kind: string) => ({
    ok: kind === 'ok',
    kind,
    message: 'x',
    modelId: 'gpt-5.4-mini',
    latencyMs: 9,
    testedAt: NOW,
  });
  const step = (onDone: () => void, items: unknown[] = []) =>
    mountStudio({
      permissions: owner,
      screen: <AiKeyStep onDone={onDone} />,
      seed: seeded(put(keys.modelConnections, { items }), put(setupKeys.modelStatus, status)),
    });
  const fill = async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('API key'), 'sk-test-key-12345678');
    await user.click(screen.getByRole('button', { name: 'Save and test' }));
    return user;
  };

  it('saves the key, tests it, and offers to go on only once it works', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections': { status: 201, json: key() },
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('ok') },
      'GET /v1/admin/model-connections': { json: { items: [key()] } },
      'GET /v1/admin/model-connections/status': { json: status },
    });
    const onDone = vi.fn();
    await step(onDone);
    const user = await fill();
    expect(await screen.findByText('The key works')).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')[0]?.body).toEqual({
      modelId: 'gpt-5.4-mini',
    });
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('does not offer to go on while the key does not work, and does once a replacement does', async () => {
    let tests = 0;
    fakeGateway({
      'POST /v1/admin/model-connections': { status: 201, json: key() },
      'POST /v1/admin/model-connections/mcn_1/test': () => ({
        json: outcome(++tests === 1 ? 'wrong_key' : 'ok'),
      }),
      'POST /v1/admin/model-connections/mcn_1/rotate': { json: key({ keyHint: 'z9y8' }) },
      'GET /v1/admin/model-connections': { json: { items: [key()] } },
      'GET /v1/admin/model-connections/status': { json: status },
    });
    const onDone = vi.fn();
    await step(onDone);
    const user = await fill();
    expect(await screen.findByText('The key wasn’t accepted')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Replace key' }));
    const dialog = await screen.findByTestId('replace-key-dialog');
    await user.type(within(dialog).getByLabelText('New API key'), 'sk-the-right-key-9999');
    await user.click(within(dialog).getByRole('button', { name: 'Replace and test' }));
    expect(await within(dialog).findByText('The key works')).toBeTruthy();
    // The window is on top of the page; the way on is there once it is closed.
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('tests a key the workspace already has, instead of asking for another', async () => {
    const gateway = fakeGateway({
      'POST /v1/admin/model-connections/mcn_1/test': { json: outcome('ok') },
    });
    const onDone = vi.fn();
    await step(onDone, [key()]);
    expect(screen.queryByLabelText('API key')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    const dialog = await screen.findByTestId('test-key-dialog');
    expect(await within(dialog).findByText('The key works')).toBeTruthy();
    expect(gateway.to('POST', '/v1/admin/model-connections/mcn_1/test')).toHaveLength(1);
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(onDone).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ the whole guide

describe('the guided setup', () => {
  const people = [
    {
      id: SELF_ID,
      displayName: 'Omar',
      email: 'omar@example.com',
      status: 'active',
      grants: [],
      teams: [],
      lastActiveAt: null,
      manageable: false,
    },
  ];
  /** A gateway that keeps the owner's progress, as the real one does. */
  const gatewayWith = (start: Record<string, 'done' | 'skipped'> = {}) => {
    let progress = {
      steps: start,
      brandId: null as string | null,
      finishedAt: null,
      updatedAt: null,
    };
    const gateway = fakeGateway({
      'GET /v1/admin/onboarding': () => ({ json: progress }),
      'PUT /v1/admin/onboarding': (call) => {
        const body = call.body as {
          steps?: Record<string, 'done' | 'skipped' | null>;
          brandId?: string | null;
          finished?: boolean;
        };
        progress = {
          ...progress,
          steps: { ...progress.steps, ...(body.steps as typeof progress.steps) },
          brandId: body.brandId === undefined ? progress.brandId : body.brandId,
        };
        return { json: progress };
      },
      'GET /v1/admin/brands': { json: { items: [brand] } },
      'GET /v1/admin/authority/connections': { json: { items: [] } },
      'POST /v1/admin/brands': {
        status: 201,
        json: { ...brand, id: 'brd_new', name: 'Northline' },
      },
      'GET /v1/admin/workspaces': { json: workspaces },
    });
    return { gateway, progress: () => progress };
  };
  const page = (at: string, permissions: readonly string[] = owner) =>
    mountStudio({
      at,
      permissions,
      screen: <OnboardingPage />,
      seed: seeded(
        put(setupKeys.onboarding, { steps: {}, brandId: null, finishedAt: null, updatedAt: null }),
        put(keys.brands, { items: [brand] }),
        put(keys.workspaces, workspaces),
        put(keys.connections, { items: [] }),
        put(keys.members, { items: people }),
        put(accessKeys.invitations, { items: [] }),
        put(keys.modelConnections, { items: [] }),
        put(setupKeys.modelStatus, {
          serverKeys: { anthropic: false, openai: false, google: false, openaiCompatible: false },
          jev: { configured: false },
          embeddings: { provider: 'mock', ready: true },
          tests: [],
        }),
      ),
    });
  const stepNow = (router: { state: { location: { search: unknown } } }) =>
    (router.state.location.search as { step?: string }).step;

  it('records a step as done and shows the next one', async () => {
    const { gateway } = gatewayWith();
    const { router } = await page('/onboarding?step=workspace');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(stepNow(router)).toBe('brand'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')[0]?.body).toEqual({
      steps: { workspace: 'done' },
    });
    expect(screen.getByTestId('onboarding-step').getAttribute('data-step')).toBe('brand');
  });

  it('records a skipped step, and goes on without doing it', async () => {
    const { gateway } = gatewayWith();
    const { router } = await page('/onboarding?step=aikey');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('onboarding-skip'));
    await waitFor(() => expect(stepNow(router)).toBe('testchat'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')[0]?.body).toEqual({
      steps: { aikey: 'skipped' },
    });
    // The skipped step stays in the list, marked, to come back to.
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-testid="onboarding-rail"] [data-step="aikey"]')
          ?.getAttribute('data-state'),
      ).toBe('skipped'),
    );
  });

  it('goes back to the step before without recording anything', async () => {
    const { gateway } = gatewayWith();
    const { router } = await page('/onboarding?step=install');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(stepNow(router)).toBe('testchat'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')).toEqual([]);
  });

  it('names the brand it made, so the steps after it work on that brand', async () => {
    const { gateway } = gatewayWith();
    const { router } = await page('/onboarding?step=brand');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add a different brand' }));
    await user.type(screen.getByLabelText('Brand name'), 'Northline');
    await user.click(screen.getByRole('button', { name: 'Create brand' }));
    await waitFor(() => expect(stepNow(router)).toBe('engine'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')[0]?.body).toEqual({
      steps: { brand: 'done' },
      brandId: 'brd_new',
    });
  });

  it('finishes the guide from the last step, and shows what was done', async () => {
    const { gateway } = gatewayWith({ workspace: 'done', brand: 'done' });
    const { router } = await page('/onboarding?step=team');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(stepNow(router)).toBe('finished'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')[0]?.body).toEqual({
      steps: { team: 'done' },
      finished: true,
    });
    expect(await screen.findByTestId('onboarding-finished')).toBeTruthy();
  });

  it('finishes just as well when the last step is skipped', async () => {
    const { gateway } = gatewayWith();
    const { router } = await page('/onboarding?step=team');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('onboarding-skip'));
    await waitFor(() => expect(stepNow(router)).toBe('finished'));
    expect(gateway.to('PUT', '/v1/admin/onboarding')[0]?.body).toEqual({
      steps: { team: 'skipped' },
      finished: true,
    });
  });

  it('stays on the step, and says why, when the progress could not be saved', async () => {
    fakeGateway({
      'PUT /v1/admin/onboarding': { problem: { status: 500, code: 'INTERNAL' } },
    });
    const { router } = await page('/onboarding?step=workspace');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('action-error')).toBeTruthy();
    expect(stepNow(router)).toBe('workspace');
  });

  it('opens any step from the list', async () => {
    gatewayWith();
    const { router } = await page('/onboarding?step=workspace');
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId('onboarding-rail')).getByRole('link', { name: /Install/ }),
    );
    await waitFor(() => expect(stepNow(router)).toBe('install'));
    expect(fireEvent).toBeTruthy();
  });
});
