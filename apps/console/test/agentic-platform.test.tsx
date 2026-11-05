// @vitest-environment jsdom
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import { newWorkflowStep, removeWorkflowStep, workflowTemplate } from '../src/lib/workflows';
import { AgencyPage } from '../src/pages/AgencyPage';
import { BrandingPage } from '../src/pages/BrandingPage';
import { ConnectorsPage } from '../src/pages/ConnectorsPage';
import { WorkflowsPage } from '../src/pages/WorkflowsPage';
import { fakeGateway, mountStudio, TENANT_ID } from './dom';

const now = '2026-10-20T09:00:00Z';
const brand = { id: 'brd_1', name: 'Noor', status: 'active', widgetId: 'wid_1' };
const seed = (client: QueryClient) => {
  client.setQueryData([TENANT_ID, ...keys.brands], { items: [brand] });
};
beforeAll(() => initI18n('en'));
describe('agency access boundaries', () => {
  it('does not offer a workspace switch when linking gives no child content access', async () => {
    fakeGateway({
      'GET /v1/admin/agency': {
        json: {
          enabled: true,
          branding: { displayName: null, accentColor: null },
          clientLimit: null,
        },
      },
      'GET /v1/admin/agency/clients': {
        json: {
          items: [
            {
              tenant: {
                id: 'tnt_child',
                name: 'Private client',
                slug: 'private',
                status: 'active',
              },
              canAccess: false,
              linkedAt: now,
            },
          ],
        },
      },
    });
    await mountStudio({ permissions: ['agency.read'], screen: <AgencyPage /> });
    await screen.findByText('Private client');
    expect(screen.queryByRole('button', { name: 'Open workspace' })).toBeNull();
    expect(screen.getByText('Separate membership required')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
  });
  it('creates an independent client with an idempotency key in the agency tenant', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/agency': {
        json: {
          enabled: true,
          branding: { displayName: null, accentColor: null },
          clientLimit: null,
        },
      },
      'GET /v1/admin/agency/clients': { json: { items: [] } },
      'POST /v1/admin/agency/clients': { status: 201, json: { tenant: { id: 'tnt_new' } } },
    });
    await mountStudio({ permissions: ['agency.read', 'agency.manage'], screen: <AgencyPage /> });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'North');
    await user.type(screen.getByLabelText('Workspace address'), 'north-client');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/agency/clients')).toHaveLength(1));
    const call = gateway.to('POST', '/v1/admin/agency/clients')[0];
    expect(call?.body).toEqual({ name: 'North', slug: 'north-client' });
    expect(call?.headers['x-hamnivo-tenant']).toBe(TENANT_ID);
    expect(call?.headers['idempotency-key']).toBeTruthy();
  });
});
describe('workflow drafts', () => {
  it('starts templates with explicit coordinator and conservative delegation budgets', () => {
    for (const template of [
      'support',
      'lead',
      'billing',
      'service',
      'afterhours',
      'handoff',
    ] as const) {
      const definition = workflowTemplate(template, 'agt_1', 'Approved help');
      expect(definition.agentId).toBe('agt_1');
      expect(definition.allowedDelegateAgentIds).toEqual([]);
      expect(definition.budget.maxDelegations).toBe(0);
      expect(definition.steps.some((s) => 'toolId' in s)).toBe(false);
    }
  });
  it('removes incoming branch and next references when deleting a step', () => {
    const draft = workflowTemplate('afterhours', 'agt_1', 'Help');
    const removed = removeWorkflowStep(draft, 'handoff');
    expect(removed.steps.some((s) => s.id === 'handoff')).toBe(false);
    expect(removed.steps.find((s) => s.id === 'knowledge')).toMatchObject({ next: null });
    expect(removed.steps.find((s) => s.id === 'hours')).toMatchObject({
      // biome-ignore lint/suspicious/noThenProperty: verifies the workflow branch contract
      then: null,
      otherwise: 'knowledge',
    });
    expect(newWorkflowStep('approval', 'approve', 'Review')).toMatchObject({
      toolId: '',
      arguments: {},
    });
  });
  it('saves a bounded workflow using the coordinator selected from the same brand', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/agents': {
        json: {
          items: [
            {
              id: 'agt_1',
              brandId: 'brd_1',
              name: 'Support',
              status: 'active',
              publishedVersion: 1,
              isDefault: true,
            },
          ],
        },
      },
      'GET /v1/admin/brands/brd_1/workflows': { json: { items: [] } },
      'POST /v1/admin/brands/brd_1/workflows': { status: 201, json: { id: 'wf_new' } },
    });
    await mountStudio({
      permissions: ['brands.manage', 'agents.read', 'automations.read', 'automations.manage'],
      seed,
      screen: <WorkflowsPage />,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create' }));
    await user.type(screen.getByLabelText('Name', { selector: '#workflow-name' }), 'Support flow');
    await user.selectOptions(screen.getByLabelText('Coordinator agent'), 'agt_1');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/admin/brands/brd_1/workflows')).toHaveLength(1),
    );
    expect(gateway.to('POST', '/v1/admin/brands/brd_1/workflows')[0]?.body).toMatchObject({
      name: 'Support flow',
      definition: {
        agentId: 'agt_1',
        allowedDelegateAgentIds: [],
        budget: { maxDelegations: 0, maxDepth: 0 },
      },
    });
  });
});
describe('connector capabilities', () => {
  it('sends only explicitly selected actions and keeps credentials out of status cards', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/connectors/catalog': {
        json: {
          items: [
            {
              key: 'invoices.read',
              title: 'View invoices',
              description: 'Only verified accounts',
              risk: 'read',
              approver: 'customer',
            },
            {
              key: 'cancellation.request',
              title: 'Request cancellation',
              description: 'Requires approval',
              risk: 'irreversible',
              approver: 'customer',
            },
          ],
        },
      },
      'GET /v1/admin/connectors': { json: { items: [] } },
      'GET /v1/admin/mcp-servers': { json: { items: [] } },
      'GET /v1/admin/tools': { json: { items: [] } },
      'POST /v1/admin/connectors': { status: 201, json: { id: 'con_1' } },
    });
    await mountStudio({
      permissions: ['brands.manage', 'tools.read', 'tools.manage'],
      seed,
      screen: <ConnectorsPage />,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByText('Create WHMCS'));
    await user.type(screen.getByLabelText('Name'), 'Billing');
    await user.type(screen.getByLabelText('WHMCS HTTPS address'), 'https://billing.example');
    await user.type(screen.getByLabelText('API identifier'), 'identifier');
    await user.type(screen.getByLabelText('API secret'), 'private-secret');
    await user.type(screen.getByLabelText('Verified identity key ID'), 'key_1');
    await user.click(screen.getByLabelText('View invoices'));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(gateway.to('POST', '/v1/admin/connectors')).toHaveLength(1));
    expect(gateway.to('POST', '/v1/admin/connectors')[0]?.body).toMatchObject({
      capabilities: ['invoices.read'],
      identityKeyId: 'key_1',
    });
    expect(screen.getByLabelText('API secret').getAttribute('value')).toBe('');
  });
});

describe('branding verification status', () => {
  it('shows DNS verification separately from routing and TLS, and uses the server verify action', async () => {
    const domain = {
      id: 'dom_1',
      hostname: 'support.client.example',
      status: 'verified',
      verification: { name: '_hamnivo.support.client.example', value: 'proof-token' },
      verifiedAt: now,
      lastCheckedAt: now,
      lastCheckResult: 'verified',
      routingReady: false,
      tlsReady: false,
      createdAt: now,
    };
    const settings = {
      portal: {
        displayName: 'Client portal',
        logoUrl: null,
        faviconUrl: null,
        accentColor: '#0B5D3B',
        fontFamily: 'system',
        showBranding: false,
      },
      email: { senderName: null, replyTo: null, logoUrl: null },
      domains: [domain],
    };
    const gateway = fakeGateway({
      'GET /v1/admin/branding': { json: settings },
      'POST /v1/admin/branding/domains/dom_1/verify': { json: domain },
    });
    await mountStudio({
      permissions: ['branding.read', 'branding.manage'],
      screen: <BrandingPage />,
    });
    await screen.findByText('Ownership verified');
    expect(screen.getByText('Routing ready: No · TLS: No')).toBeDefined();
    expect(screen.queryByText('Active')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Verify DNS' }));
    await waitFor(() =>
      expect(gateway.to('POST', '/v1/admin/branding/domains/dom_1/verify')).toHaveLength(1),
    );
  });
});

describe('live WHMCS user permission preview', () => {
  it('shows per-action denial even when live permission parsing succeeds', async () => {
    const gateway = fakeGateway({
      'GET /v1/admin/connectors/catalog': {
        json: {
          items: [
            {
              key: 'invoices.read',
              title: 'View invoices',
              description: 'Verified users only',
              risk: 'read',
              approver: 'customer',
            },
          ],
        },
      },
      'GET /v1/admin/connectors': {
        json: {
          items: [
            {
              id: 'con_1',
              brandId: 'brd_1',
              kind: 'whmcs',
              label: 'Billing',
              baseUrl: 'https://billing.example',
              status: 'active',
              capabilities: ['invoices.read'],
              grantVersion: 1,
              lastTestedAt: null,
              lastError: null,
              identityKeyId: 'kid_1',
            },
          ],
        },
      },
      'GET /v1/admin/tools': { json: { items: [] } },
      'GET /v1/admin/mcp-servers': { json: { items: [] } },
      'POST /v1/admin/connectors/con_1/permissions/test': {
        json: {
          ok: true,
          checkedAt: now,
          userId: 42,
          clientId: 7,
          items: [
            {
              capability: 'invoices.read',
              configured: true,
              requiredPermission: 'invoices',
              allowed: false,
              reason: 'permission_denied',
            },
          ],
        },
      },
    });
    await mountStudio({
      permissions: ['brands.manage', 'tools.read', 'tools.manage'],
      seed,
      screen: <ConnectorsPage />,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByText('Test WHMCS user permissions'));
    await user.type(screen.getByLabelText('WHMCS user ID'), '42');
    await user.type(screen.getByLabelText('WHMCS client ID'), '7');
    await user.click(screen.getByRole('button', { name: 'Check permissions' }));
    await screen.findByText('User permission denied');
    expect(gateway.to('POST', '/v1/admin/connectors/con_1/permissions/test')[0]?.body).toEqual({
      userId: 42,
      clientId: 7,
    });
    expect(gateway.writes()).toHaveLength(1);
  });
});

describe('named workflow resources', () => {
  it('preserves unavailable selections and result predicates, then saves named tool and specialist choices', async () => {
    const definition = {
      agentId: 'agt_main',
      allowedDelegateAgentIds: [],
      entry: 'action',
      trigger: { type: 'manual' },
      budget: { maxSteps: 20, maxDelegations: 1, maxDurationSeconds: 3600, maxDepth: 1 },
      steps: [
        {
          id: 'action',
          label: 'Check invoice',
          type: 'tool_action',
          toolId: 'tool_removed',
          arguments: {},
          next: 'specialist',
        },
        {
          id: 'specialist',
          label: 'Ask billing',
          type: 'delegate',
          connectionId: 'connection_removed',
          request: 'Review invoice',
          next: 'branch',
        },
        {
          id: 'branch',
          label: 'Review balance',
          type: 'condition',
          predicate: {
            field: 'result',
            op: 'is',
            value: 0,
            source: { stepId: 'action', path: ['balance'] },
          },
          // biome-ignore lint/suspicious/noThenProperty: workflow graph target, not a thenable
          then: 'end',
          otherwise: 'end',
        },
        { id: 'end', label: 'Staff help', type: 'handoff', reason: 'Staff review' },
      ],
    };
    const workflow = {
      id: 'wf_1',
      brandId: 'brd_1',
      name: 'Existing automation',
      enabled: false,
      revision: 1,
      draft: definition,
      published: null,
      unpublishedChanges: true,
      createdAt: now,
      updatedAt: now,
    };
    const gateway = fakeGateway({
      'GET /v1/admin/agents': {
        json: {
          items: [
            {
              id: 'agt_main',
              brandId: 'brd_1',
              name: 'Coordinator',
              isDefault: true,
              status: 'active',
              publishedVersion: 1,
            },
            {
              id: 'agt_spec',
              brandId: 'brd_1',
              name: 'Billing specialist',
              status: 'active',
              publishedVersion: 2,
            },
            {
              id: 'agt_foreign',
              brandId: 'brd_other',
              name: 'Other client specialist',
              status: 'active',
              publishedVersion: 1,
            },
          ],
        },
      },
      'GET /v1/admin/tools': {
        json: {
          items: [
            {
              id: 'tool_invoice',
              brandId: 'brd_1',
              title: 'View invoices',
              status: 'enabled',
              stopped: false,
            },
          ],
        },
      },
      'GET /v1/admin/brands/brd_1/a2a-connections': {
        json: { items: [{ id: 'aac_billing', name: 'External billing desk', enabled: true }] },
      },
      'GET /v1/admin/brands/brd_1/workflows': { json: { items: [workflow] } },
      'GET /v1/admin/workflows/wf_1/versions': { json: { items: [] } },
      'GET /v1/admin/workflows/wf_1/runs': { json: { items: [] } },
      'PUT /v1/admin/workflows/wf_1': { json: workflow },
    });
    await mountStudio({
      permissions: [
        'brands.manage',
        'agents.read',
        'tools.read',
        'automations.read',
        'automations.manage',
      ],
      seed,
      screen: <WorkflowsPage />,
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Existing automation/ }));
    const tool = screen.getByLabelText('Action tool') as HTMLSelectElement;
    const specialist = screen.getByLabelText('Specialist') as HTMLSelectElement;
    expect(tool.value).toBe('tool_removed');
    expect(specialist.value).toBe('connection:connection_removed');
    expect(
      (
        screen.getByRole('option', {
          name: 'Unavailable tool (saved selection)',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('option', {
          name: 'Unavailable specialist (saved selection)',
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole('option', { name: /Other client specialist/ })).toBeNull();
    expect(screen.getByTestId('advanced-result-predicate')).toBeDefined();
    expect(screen.queryByLabelText('Customer field')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Start when'), 'customer_message');
    expect(
      (document.querySelector('#workflow-agent option[value="agt_spec"]') as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    await user.selectOptions(screen.getByLabelText('Start when'), 'manual');
    await user.type(screen.getByLabelText('Name', { selector: '#workflow-name' }), ' reviewed');
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(gateway.to('PUT', '/v1/admin/workflows/wf_1')).toHaveLength(1));
    expect(gateway.to('PUT', '/v1/admin/workflows/wf_1')[0]?.body).toMatchObject({
      definition: {
        steps: expect.arrayContaining([{ ...definition.steps[0] }, { ...definition.steps[2] }]),
      },
    });
    await user.click(await screen.findByRole('button', { name: /Existing automation/ }));
    await user.selectOptions(
      screen.getByLabelText('Action tool'),
      await screen.findByRole('option', { name: 'View invoices' }),
    );
    await user.selectOptions(
      screen.getByLabelText('Specialist'),
      await screen.findByRole('option', {
        name: 'Internal agent: Billing specialist',
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(gateway.to('PUT', '/v1/admin/workflows/wf_1')).toHaveLength(2));
    expect(gateway.to('PUT', '/v1/admin/workflows/wf_1')[1]?.body).toMatchObject({
      definition: {
        allowedDelegateAgentIds: ['agt_spec'],
        steps: expect.arrayContaining([
          expect.objectContaining({ id: 'action', toolId: 'tool_invoice' }),
          expect.objectContaining({ id: 'specialist', agentId: 'agt_spec' }),
        ]),
      },
    });
    const savedDefinition = gateway.to('PUT', '/v1/admin/workflows/wf_1')[1]?.body?.definition as
      | { steps: { id: string; connectionId?: string }[] }
      | undefined;
    expect(
      savedDefinition?.steps.find((step) => step.id === 'specialist')?.connectionId,
    ).toBeUndefined();
  });
});
