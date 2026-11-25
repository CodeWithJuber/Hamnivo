// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { keys } from '../src/lib/queries';
import { AgentsPage } from '../src/pages/AgentsPage';
import { fakeGateway, mountStudio, TENANT_ID } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const at = '2026-10-01T09:00:00.000Z';
const agent = (id: string, patch: Record<string, unknown>) => ({
  id,
  workspaceId: 'wsp_1',
  brandId: 'brd_1',
  status: 'active',
  isDefault: false,
  publishedVersion: 1,
  draftVersion: null,
  createdAt: at,
  updatedAt: at,
  ...patch,
});
const version = (config: Record<string, unknown>) => ({
  config: {
    displayName: 'Assistant',
    purpose: '',
    mode: 'answer',
    model: { provider: 'openai', modelId: 'gpt-5-mini' },
    ...config,
  },
});
const AGENTS = [
  agent('agt_1', { name: 'Noor support', isDefault: true }),
  agent('agt_2', { name: 'Returns bot', brandId: 'brd_2' }),
  agent('agt_3', { name: 'Draft helper', publishedVersion: null, draftVersion: 1 }),
];
const DETAILS: Record<string, unknown> = {
  agt_1: {
    agent: AGENTS[0],
    published: version({ purpose: 'Order questions and delivery times' }),
    draft: null,
  },
  agt_2: {
    agent: AGENTS[1],
    published: version({ purpose: 'Refunds and exchanges' }),
    draft: null,
  },
  agt_3: { agent: AGENTS[2], published: null, draft: version({ purpose: '' }) },
};
const BRANDS = [
  { id: 'brd_1', name: 'Noor Books', status: 'active' },
  { id: 'brd_2', name: 'Kitab Store', status: 'active' },
];

const mount = (brands = BRANDS) => {
  fakeGateway({});
  return mountStudio({
    at: '/agents',
    permissions: presetPermissions('owner'),
    screen: <AgentsPage />,
    seed: (client) => {
      client.setQueryData([TENANT_ID, ...keys.agents], { items: AGENTS });
      for (const [id, detail] of Object.entries(DETAILS)) {
        client.setQueryData([TENANT_ID, ...keys.agent(id)], detail);
      }
      client.setQueryData([TENANT_ID, ...keys.brands], {
        items: brands.map((b) => ({
          ...b,
          workspaceId: 'wsp_1',
          widgetId: `wid_${b.id}`,
          allowedOrigins: [],
          businessHours: null,
          createdAt: at,
        })),
      });
    },
  });
};

const rows = () =>
  within(screen.getByTestId('agents-table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.getAttribute('data-agent'));

describe('the agent directory (HNV-11-01)', () => {
  it('says what each agent is for and where it answers', async () => {
    await mount();
    expect(rows()).toEqual(['Noor support', 'Returns bot', 'Draft helper']);
    const answers = screen
      .getAllByText((_, el) => el?.hasAttribute('data-answer') ?? false)
      .map((el) => [el.getAttribute('data-answer'), el.textContent]);
    expect(answers).toEqual([
      [
        'customers',
        'Answers customers of Noor Books in web chat and on the brand’s channels where the AI is on.',
      ],
      [
        'notDefault',
        'Answers no one: only the default agent of Kitab Store answers. Make it the default to use it.',
      ],
      ['notLive', 'Answers no one yet: it has not been published.'],
    ]);
    const purposes = screen.getAllByTestId('agent-purpose').map((el) => el.textContent);
    expect(purposes).toEqual([
      'Order questions and delivery times',
      'Refunds and exchanges',
      'No purpose written yet.',
    ]);
  });

  it('narrows as you type, says how many are shown, and clears back to all', async () => {
    const user = userEvent.setup({ delay: null });
    await mount();
    const count = screen.getByTestId('agents-count');
    expect(count.getAttribute('role')).toBe('status');
    expect(count.textContent).toBe('');

    await user.type(screen.getByLabelText('Search agents'), 'refunds');
    expect(rows()).toEqual(['Returns bot']);
    expect(count.textContent).toBe('Showing 1 of 3 agents.');

    await user.clear(screen.getByLabelText('Search agents'));
    await user.type(screen.getByLabelText('Search agents'), 'nothing like this');
    expect(screen.queryByTestId('agents-table')).toBeNull();
    expect(screen.getByText('No agent matches these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(rows()).toEqual(['Noor support', 'Returns bot', 'Draft helper']);
    expect((screen.getByLabelText('Search agents') as HTMLInputElement).value).toBe('');
  });

  it('filters by brand and by whether an agent answers now', async () => {
    const user = userEvent.setup({ delay: null });
    await mount();
    await user.selectOptions(screen.getByLabelText('Brand'), 'brd_2');
    expect(rows()).toEqual(['Returns bot']);
    await user.selectOptions(screen.getByLabelText('Brand'), '');
    await user.selectOptions(screen.getByLabelText('Show'), 'answering');
    expect(rows()).toEqual(['Noor support']);
    await user.selectOptions(screen.getByLabelText('Show'), 'idle');
    expect(rows()).toEqual(['Returns bot', 'Draft helper']);
  });

  it('offers the brand filter only when the agents belong to more than one brand', async () => {
    fakeGateway({});
    await mountStudio({
      at: '/agents',
      permissions: presetPermissions('owner'),
      screen: <AgentsPage />,
      seed: (client) => {
        client.setQueryData([TENANT_ID, ...keys.agents], { items: [AGENTS[0]] });
        client.setQueryData([TENANT_ID, ...keys.agent('agt_1')], DETAILS.agt_1);
      },
    });
    expect(screen.queryByLabelText('Brand')).toBeNull();
    expect(screen.getByLabelText('Show')).toBeTruthy();
  });
});
