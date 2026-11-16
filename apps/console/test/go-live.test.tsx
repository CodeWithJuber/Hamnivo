// @vitest-environment jsdom
import { presetPermissions } from '@hamnivo/policy';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { GoLiveNotices } from '../src/components/agent/GoLiveNotices';
import { initI18n } from '../src/i18n';
import { fakeGateway, mountStudio } from './dom';

beforeAll(async () => {
  await initI18n('en');
});

const NOW = '2026-11-16T09:00:00.000Z';
const owner = presetPermissions('owner');

const agent = (patch: Record<string, unknown> = {}) => ({
  id: 'agt_1',
  workspaceId: 'wsp_1',
  brandId: 'brd_1',
  name: 'Noor Books assistant',
  status: 'active',
  isDefault: true,
  publishedVersion: 1,
  draftVersion: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
});
const version = (model: Record<string, unknown>, state = 'published') => ({
  id: 'agv_1',
  agentId: 'agt_1',
  version: 1,
  state,
  config: {
    displayName: 'AI assistant',
    purpose: '',
    instructions: '',
    tone: 'warm',
    languages: ['en'],
    mode: 'answer',
    model,
    fallbackModels: [],
    limits: { maxOutputTokens: 600, timeoutMs: 30000, historyMessages: 20, maxSteps: 4 },
    knowledgeSourceIds: [],
    memory: { enabled: false, maxItems: 8, maxChars: 1200 },
    tools: { grants: [], maxCallsPerRun: 4, maxAutopilotPerConversation: 5 },
  },
  configHash: 'ab',
  createdAt: NOW,
  publishedAt: NOW,
  publishedBy: null,
  updatedAt: NOW,
});
const MOCK = { provider: 'mock', modelId: 'hamnivo-mock' };
const REAL = { provider: 'openai', modelId: 'gpt-5.4-mini', connectionId: 'mcn_1' };

function gateway(
  published: Record<string, unknown> | null,
  goLive: Parameters<typeof fakeGateway>[0][string],
) {
  return fakeGateway({
    'GET /v1/admin/agents': {
      json: { items: [agent(published ? {} : { publishedVersion: null, draftVersion: 1 })] },
    },
    'GET /v1/admin/agents/agt_1': {
      json: {
        agent: agent(),
        published: published ? version(published) : null,
        draft: published ? null : version(MOCK, 'draft'),
      },
    },
    'GET /v1/admin/brands': {
      json: { items: [{ id: 'brd_1', name: 'Noor Books', status: 'active', allowedOrigins: [] }] },
    },
    'POST /v1/admin/agents/agt_1/go-live': goLive,
  });
}

describe('making the assistant live', () => {
  it('says plainly when customers get the test model’s fixed reply, and fixes it in one click', async () => {
    const fake = gateway(MOCK, { json: { agent: agent(), published: version(REAL), draft: null } });
    await mountStudio({ permissions: owner, screen: <GoLiveNotices /> });
    const notice = await screen.findByTestId('go-live-notice');
    // Named by its brand once the brand list is in.
    await within(notice).findByRole('heading', { name: 'Noor Books: customers get a test reply' });
    expect(notice.textContent).toContain('same fixed reply');
    await userEvent
      .setup()
      .click(within(notice).getByRole('button', { name: 'Make the assistant live' }));
    await waitFor(() => expect(fake.to('POST', '/v1/admin/agents/agt_1/go-live')).toHaveLength(1));
    expect(fake.to('POST', '/v1/admin/agents/agt_1/go-live')[0]?.body).toEqual({});
  });

  it('says so too when the assistant was never published', async () => {
    gateway(null, { json: {} });
    await mountStudio({ permissions: owner, screen: <GoLiveNotices /> });
    const notice = await screen.findByTestId('go-live-notice');
    await within(notice).findByRole('heading', { name: 'Noor Books: the AI does not answer yet' });
  });

  it('points to the AI key page when there is no key to go live with', async () => {
    gateway(MOCK, {
      problem: {
        status: 422,
        code: 'VALIDATION_FAILED',
        detail: 'Add an AI key under AI models first.',
        fields: [{ path: 'connectionId', message: 'Add an AI key under AI models first.' }],
      },
    });
    await mountStudio({ permissions: owner, screen: <GoLiveNotices /> });
    const notice = await screen.findByTestId('go-live-notice');
    await userEvent
      .setup()
      .click(within(notice).getByRole('button', { name: 'Make the assistant live' }));
    expect((await within(notice).findByRole('alert')).textContent).toBe(
      'Add an AI key first, then come back here.',
    );
    expect(within(notice).getByRole('link', { name: 'Add an AI key' }).getAttribute('href')).toBe(
      '/models',
    );
  });

  it('shows nothing once the assistant answers on a real model, or to someone who cannot publish', async () => {
    gateway(REAL, { json: {} });
    const live = await mountStudio({ permissions: owner, screen: <GoLiveNotices /> });
    await waitFor(() => expect(live.container.textContent).toBe(''));
    live.unmount();
    gateway(MOCK, { json: {} });
    const agentOnly = await mountStudio({
      permissions: presetPermissions('agent'),
      screen: <GoLiveNotices />,
    });
    expect(agentOnly.container.textContent).toBe('');
  });
});
