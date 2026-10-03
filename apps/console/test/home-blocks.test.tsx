import { presetPermissions } from '@hamnivo/policy';
import type { QueryClient } from '@tanstack/react-query';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { accessKeys } from '../src/lib/access';
import { inboxKeys } from '../src/lib/inbox';
import { keys } from '../src/lib/queries';
import { OverviewPage } from '../src/pages/OverviewPage';
import { anchors, renderStudio, SELF_ID, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const home = (permissions: readonly string[], seed?: (client: QueryClient) => void) =>
  renderStudio({
    at: '/overview',
    permissions,
    screen: <OverviewPage />,
    ...(seed ? { seed } : {}),
  });

const insideTestId = (html: string, id: string) => {
  const match = html.match(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]*?)</div>`));
  return textOf(match?.[1] ?? '');
};

// ------------------------------------------------------------------ the workspace's lists

const brand = {
  id: 'brd_1',
  workspaceId: 'wsp_1',
  name: 'Noor Books',
  widgetId: 'wid_1',
  allowedOrigins: ['https://noor.example.com'],
  businessHours: null,
  status: 'active',
  createdAt: '2026-10-01T09:00:00.000Z',
};
const connection = {
  id: 'con_1',
  kind: 'chatwoot',
  baseUrl: 'https://chat.example.com',
  accountId: 1,
  status: 'active',
  inboxes: [{ id: 'inb_1', brandId: 'brd_1', purpose: 'live', externalInboxId: 1 }],
  createdAt: '2026-10-01T09:00:00.000Z',
};
const agent = {
  id: 'agt_1',
  workspaceId: 'wsp_1',
  brandId: 'brd_1',
  name: 'Noor assistant',
  status: 'active',
  isDefault: true,
  publishedVersion: 1,
  draftVersion: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};
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
const me = member(SELF_ID, 'Omar');

interface Lists {
  connections: unknown[];
  brands: unknown[];
  agents: unknown[];
  members: unknown[];
  invitations: unknown[];
}
const workspaceWith = (lists: Partial<Lists>) => (client: QueryClient) => {
  const all: Lists = {
    connections: [],
    brands: [],
    agents: [],
    members: [me],
    invitations: [],
    ...lists,
  };
  client.setQueryData([TENANT_ID, ...keys.connections], { items: all.connections });
  client.setQueryData([TENANT_ID, ...keys.brands], { items: all.brands });
  client.setQueryData([TENANT_ID, ...keys.agents], { items: all.agents });
  client.setQueryData([TENANT_ID, ...keys.members], { items: all.members });
  client.setQueryData([TENANT_ID, ...accessKeys.invitations], { items: all.invitations });
};
const chatsWith =
  (counts: Record<'mine' | 'unassigned' | 'ai' | 'team' | 'all', number>) =>
  (client: QueryClient) => {
    client.setQueryData([TENANT_ID, ...inboxKeys.list({}), 1], {
      pages: [{ items: [], nextCursor: null, counts }],
      pageParams: [''],
    });
  };

const owner = presetPermissions('owner');
const setUp = (html: string) =>
  anchors(html)
    .filter((link) => link.attrs['data-step'])
    .map((link) => [link.attrs['data-step'], link.href]);

describe('Home for staff who do not run the workspace', () => {
  // The Analyst can read conversations but neither manages brands nor sees the team.
  const analyst = presetPermissions('analyst');

  it('starts with their chats: who is waiting and what is theirs', async () => {
    const html = await home(analyst, chatsWith({ mine: 2, unassigned: 3, ai: 1, team: 0, all: 6 }));
    expect(html).toContain('Your chats');
    expect(insideTestId(html, 'chats-waiting')).toBe('Waiting for a person 3');
    expect(insideTestId(html, 'chats-mine')).toBe('Assigned to you 2');
    expect(html).not.toContain('Get set up');
  });

  it('has a primary button into the inbox', async () => {
    const html = await home(analyst, chatsWith({ mine: 0, unassigned: 0, ai: 0, team: 0, all: 0 }));
    const open = anchors(html).find((link) => link.text === 'Open inbox');
    expect(open?.href).toBe('/inbox');
    expect(open?.attrs['data-variant']).toBe('default');
    expect(textOf(html)).toContain('Nothing is waiting for you right now.');
  });

  it('keeps the way into the inbox while the counts load', async () => {
    const html = await home(analyst);
    expect(anchors(html).find((link) => link.text === 'Open inbox')?.href).toBe('/inbox');
  });

  it('has no chats to show someone who cannot read the inbox, and no setup either', async () => {
    const html = await home(presetPermissions('billing'), workspaceWith({}));
    expect(html).not.toContain('Your chats');
    expect(html).not.toContain('Get set up');
  });

  it('is not given the setup list, even in a workspace that has nothing yet', async () => {
    const html = await home(analyst, workspaceWith({}));
    expect(html).not.toContain('Get set up');
  });
});

describe('Home for people who run the workspace', () => {
  it('lists every step of a new workspace, each linking to its page', async () => {
    const html = await home(owner, workspaceWith({}));
    expect(html).toContain('Get set up');
    expect(setUp(html)).toEqual([
      ['engine', '/brands'],
      ['brand', '/brands'],
      ['agent', '/agents'],
      ['team', '/team'],
    ]);
    const titles = anchors(html)
      .filter((link) => link.attrs['data-step'])
      .map((link) => link.text);
    expect(titles[0]).toContain('Connect the chat engine');
    expect(titles[1]).toContain('Add a brand and install the chat');
    expect(titles[2]).toContain('Publish an AI agent');
    expect(titles[3]).toContain('Invite a teammate');
    expect(html).not.toContain('Your chats');
  });

  it('shows only the steps that are not done', async () => {
    const html = await home(
      owner,
      workspaceWith({ connections: [connection], brands: [brand], agents: [] }),
    );
    expect(setUp(html)).toEqual([
      ['agent', '/agents'],
      ['team', '/team'],
    ]);
  });

  it('hides the whole list once every step is done', async () => {
    const html = await home(
      owner,
      workspaceWith({
        connections: [connection],
        brands: [brand],
        agents: [agent],
        members: [me, member('staff_2', 'Sara')],
      }),
    );
    expect(html).not.toContain('Get set up');
    expect(html).not.toContain('data-testid="setup-steps"');
    // The overview below it is still there.
    expect(html).toContain('Noor Books');
  });

  it('counts an invitation that was sent as the teammate', async () => {
    const html = await home(
      owner,
      workspaceWith({
        connections: [connection],
        brands: [brand],
        agents: [agent],
        invitations: [{ id: 'inv_1', email: 'sara@example.com', status: 'pending' }],
      }),
    );
    expect(html).not.toContain('Get set up');
  });

  it('says nothing until the lists are in', async () => {
    const html = await home(owner);
    expect(html).not.toContain('Get set up');
    expect(html).not.toContain('data-testid="setup-steps"');
  });

  it('skips a step it cannot be told about, and a step the person cannot do', async () => {
    // Someone who manages brands and reads the team, but cannot connect, publish or invite.
    const html = await home(['brands.manage', 'members.read'], workspaceWith({}));
    expect(setUp(html)).toEqual([['brand', '/brands']]);
  });
});
