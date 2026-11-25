// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import { ConnectorsPage } from '../src/pages/ConnectorsPage';
import { AssistantReadiness } from '../src/pages/home/AssistantReadiness';
import { fakeGateway, mountStudio, settle, TENANT_ID } from './dom';

/**
 * The guided path to an AI that can act on WHMCS: Home's checklist says what is left, in order,
 * with one button each, and the WHMCS form picks or makes the customer sign-in key itself.
 */

beforeAll(() => initI18n('en'));

const NOW = '2026-11-23T09:00:00.000Z';
const owner = presetPermissions('owner');
const brand = { id: 'brd_1', name: 'Hostlelo', status: 'active', widgetId: 'wid_1' };
const seed = (client: QueryClient) => {
  client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
};
const agent = {
  id: 'agt_1',
  workspaceId: 'wsp_1',
  brandId: 'brd_1',
  name: 'Assistant',
  status: 'active',
  isDefault: true,
  publishedVersion: 1,
  draftVersion: null,
  createdAt: NOW,
  updatedAt: NOW,
};
const version = (grants: string[]) => ({
  id: 'agv_1',
  agentId: 'agt_1',
  version: 1,
  state: 'published',
  configHash: null,
  config: {
    model: { provider: 'anthropic', modelId: 'claude-haiku-5-5' },
    tools: { grants: grants.map((toolId) => ({ toolId, autopilot: true })) },
  },
});
const key = (kid: string, status = 'active') => ({
  kid,
  alg: 'HS256',
  status,
  publicJwk: null,
  createdAt: NOW,
  retiredAt: null,
});

/** The lists Home reads for a brand with a tested AI key and a live agent, and nothing else. */
function homeRoutes(patch: Record<string, unknown> = {}) {
  return {
    'GET /v1/admin/agents': { json: { items: [agent] } },
    'GET /v1/admin/agents/agt_1': { json: { agent, published: version([]), draft: null } },
    'GET /v1/admin/model-connections': {
      json: { items: [{ id: 'mcn_1', provider: 'anthropic', status: 'active' }] },
    },
    'GET /v1/admin/model-connections/status': {
      json: {
        serverKeys: { anthropic: false, openai: false, google: false, openaiCompatible: false },
        jev: { configured: false },
        embeddings: { provider: 'mock', ready: true },
        tests: [{ connectionId: 'mcn_1', ok: true, kind: 'ok', modelId: 'm', testedAt: NOW }],
      },
    },
    'GET /v1/admin/brands/brd_1/identity-keys': { json: { items: [] } },
    'GET /v1/admin/connectors': { json: { items: [] } },
    'GET /v1/admin/tools': { json: { items: [] } },
    'GET /v1/admin/tools/builtins': { json: { items: [] } },
    ...patch,
  };
}

describe('the "Make the AI assistant work" checklist on Home', () => {
  it('shows each step in order with its state, and one button to where it is done', async () => {
    fakeGateway(homeRoutes());
    await mountStudio({ permissions: owner, seed, screen: <AssistantReadiness /> });
    const list = await screen.findByTestId('readiness-steps');
    const steps = within(list).getAllByRole('listitem');
    expect(steps.map((step) => [step.dataset.step, step.dataset.state])).toEqual([
      ['aikey', 'done'],
      ['model', 'done'],
      ['signin', 'todo'],
      ['whmcs', 'todo'],
      ['actions', 'todo'],
      ['demo', 'done'],
      ['website', 'check'],
    ]);
    // The first thing left to do stands out, and says what to do in plain words.
    const signin = steps[2] as HTMLElement;
    expect(signin.getAttribute('aria-current')).toBe('step');
    expect(within(signin).getByText('To do')).toBeTruthy();
    expect(within(signin).getByText(/tell the chat which client is signed in/)).toBeTruthy();
    expect(
      within(signin)
        .getByRole('link', { name: /Open Customer sign-in/ })
        .getAttribute('href'),
    ).toBe('/customer-identity');
    // A step that needs an earlier one says so.
    expect(
      within(steps[4] as HTMLElement).getByText(/Connect WHMCS first \(step 4\)/),
    ).toBeTruthy();
    expect(
      within(steps[4] as HTMLElement).getByRole('link', { name: /Open the agent’s tools/ }),
    ).toHaveProperty('pathname', '/agents/agt_1');
    // The website step links to the guide, in a new tab.
    const guide = within(steps[6] as HTMLElement).getByRole('link', { name: /Open the guide/ });
    expect(guide.getAttribute('target')).toBe('_blank');
    expect(guide.getAttribute('href')).toMatch(/whmcs.*#signed-in-clients-optional$/);
  });

  it('says why an AI key does not work', async () => {
    fakeGateway(
      homeRoutes({
        'GET /v1/admin/model-connections/status': {
          json: {
            serverKeys: { anthropic: false, openai: false, google: false, openaiCompatible: false },
            jev: { configured: false },
            embeddings: { provider: 'mock', ready: true },
            tests: [
              { connectionId: 'mcn_1', ok: false, kind: 'wrong_key', modelId: 'm', testedAt: NOW },
            ],
          },
        },
      }),
    );
    await mountStudio({ permissions: owner, seed, screen: <AssistantReadiness /> });
    const step = await screen.findByText('An AI key that works');
    const row = step.closest('li') as HTMLElement;
    expect(row.dataset.state).toBe('attention');
    expect(within(row).getByText('Needs attention')).toBeTruthy();
    expect(within(row).getByText(/did not accept the key/)).toBeTruthy();
  });

  it('waits for "Get set up" while there is no AI key or no live agent', async () => {
    fakeGateway(homeRoutes({ 'GET /v1/admin/model-connections': { json: { items: [] } } }));
    const first = await mountStudio({ permissions: owner, seed, screen: <AssistantReadiness /> });
    await settle();
    expect(screen.queryByTestId('readiness-steps')).toBeNull();
    first.unmount();

    fakeGateway(
      homeRoutes({
        'GET /v1/admin/agents': { json: { items: [{ ...agent, publishedVersion: null }] } },
      }),
    );
    await mountStudio({ permissions: owner, seed, screen: <AssistantReadiness /> });
    await settle();
    expect(screen.queryByTestId('readiness-steps')).toBeNull();
  });

  it('is gone once everything is in place', async () => {
    fakeGateway(
      homeRoutes({
        'GET /v1/admin/agents/agt_1': {
          json: { agent, published: version(['tool_whmcs']), draft: null },
        },
        'GET /v1/admin/brands/brd_1/identity-keys': { json: { items: [key('whmcs-2026-11')] } },
        'GET /v1/admin/connectors': {
          json: { items: [{ id: 'con_1', kind: 'whmcs', status: 'active', lastError: null }] },
        },
        'GET /v1/admin/tools': {
          json: {
            items: [
              {
                id: 'tool_whmcs',
                source: 'native',
                builtin: null,
                resourceType: 'whmcs',
                status: 'enabled',
              },
            ],
          },
        },
      }),
    );
    await mountStudio({ permissions: owner, seed, screen: <AssistantReadiness /> });
    await settle();
    expect(screen.queryByTestId('readiness-steps')).toBeNull();
  });
});

describe('the WHMCS connection form', () => {
  const catalog = {
    items: [
      {
        kind: 'whmcs',
        key: 'invoices.read',
        title: 'View invoices',
        description: 'Only verified accounts',
        risk: 'read',
        approver: 'customer',
      },
    ],
  };
  const routes = (keys: unknown[]) => ({
    'GET /v1/admin/connectors/catalog': { json: catalog },
    'GET /v1/admin/connectors': { json: { items: [] } },
    'GET /v1/admin/mcp-servers': { json: { items: [] } },
    'GET /v1/admin/tools': { json: { items: [] } },
    'GET /v1/admin/brands/brd_1/identity-keys': { json: { items: keys } },
    'POST /v1/admin/connectors': { status: 201, json: { id: 'con_1' } },
  });

  it('shows the three steps and picks the brand’s only sign-in key by itself', async () => {
    const gateway = fakeGateway(routes([key('old-key', 'revoked'), key('whmcs-2026-11')]));
    await mountStudio({ permissions: owner, seed, screen: <ConnectorsPage /> });
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByText('Create WHMCS'));
    const steps = screen.getByTestId('whmcs-steps');
    expect(within(steps).getAllByRole('listitem')).toHaveLength(3);
    expect(within(steps).getByText(/Manage API Credentials/)).toBeTruthy();

    const picker = (await screen.findByLabelText('Customer sign-in key')) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('whmcs-2026-11'));
    // A revoked key is not offered.
    expect([...picker.options].map((option) => option.value)).toEqual(['', 'whmcs-2026-11']);

    const form = within(steps.closest('form') as HTMLElement);
    await user.type(form.getByLabelText('Name'), 'Billing');
    await user.type(form.getByLabelText('WHMCS HTTPS address'), 'https://billing.example');
    await user.type(form.getByLabelText('API identifier'), 'identifier');
    await user.type(form.getByLabelText('API secret'), 'private-secret');
    await user.click(form.getByLabelText(/View invoices/));
    await user.click(form.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/connectors')).toHaveLength(1));
    expect(gateway.to('POST', '/v1/admin/connectors')[0]?.body).toMatchObject({
      identityKeyId: 'whmcs-2026-11',
    });
  });

  it('offers to create a key right there when the brand has none', async () => {
    fakeGateway(routes([]));
    await mountStudio({ permissions: owner, seed, screen: <ConnectorsPage /> });
    const user = userEvent.setup({ delay: null });
    await user.click(await screen.findByText('Create WHMCS'));
    expect(await screen.findByTestId('whmcs-no-key')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Create a key' }));
    expect(
      await screen.findByRole('dialog', { name: 'Create a customer sign-in key' }),
    ).toBeTruthy();
  });
});
