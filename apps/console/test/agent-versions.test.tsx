import { presetPermissions } from '@hamnivo/policy';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentVersions, previousLive } from '../src/components/AgentVersions';
import { initI18n } from '../src/i18n';
import { formatDateTime } from '../src/lib/format';
import { keys } from '../src/lib/queries';
import type { AgentVersion } from '../src/lib/types';
import { anchors, renderStudio, TENANT_ID, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const version = (
  n: number,
  state: AgentVersion['state'],
  updatedAt: string,
  published: string | null = updatedAt,
): AgentVersion =>
  ({
    id: `agv_${n}`,
    agentId: 'agt_1',
    version: n,
    state,
    config: {},
    configHash: published ? `hash${n}`.padEnd(64, '0') : null,
    createdAt: '2026-10-01T08:00:00.000Z',
    publishedAt: published,
    publishedBy: null,
    updatedAt,
  }) as unknown as AgentVersion;

// Version 1 was live, then 2, then 3; 2 is the one retired last, so it was live before 3.
const VERSIONS = [
  version(4, 'draft', '2026-10-05T09:00:00.000Z', null),
  version(3, 'published', '2026-10-04T09:00:00.000Z'),
  version(2, 'retired', '2026-10-04T09:00:00.000Z', '2026-10-03T09:00:00.000Z'),
  version(1, 'retired', '2026-10-03T09:00:00.000Z', '2026-10-02T09:00:00.000Z'),
];

describe('the version that was live before', () => {
  it('is the published one retired last', () => {
    expect(previousLive(VERSIONS)).toBe(2);
    // After a rollback to 1, version 3 was retired last.
    expect(
      previousLive([
        version(3, 'retired', '2026-10-06T09:00:00.000Z', '2026-10-04T09:00:00.000Z'),
        version(2, 'retired', '2026-10-04T09:00:00.000Z', '2026-10-03T09:00:00.000Z'),
        version(1, 'published', '2026-10-06T09:00:00.000Z', '2026-10-02T09:00:00.000Z'),
      ]),
    ).toBe(3);
    // Nothing was live before the first publication.
    expect(previousLive([version(1, 'published', '2026-10-02T09:00:00.000Z')])).toBeUndefined();
    expect(previousLive(undefined)).toBeUndefined();
  });
});

const panel = (permissions: readonly string[]) =>
  renderStudio({
    at: '/agents/agt_1',
    permissions,
    screen: <AgentVersions agentId="agt_1" publishedVersion={3} onRollback={async () => {}} />,
    seed: (client) =>
      client.setQueryData([TENANT_ID, ...keys.agent('agt_1'), 'versions'], { items: VERSIONS }),
  });

const item = (html: string, n: number) =>
  html.match(new RegExp(`<li[^>]*data-version="${n}"[\\s\\S]*?</li>`))?.[0] ?? '';

describe('the versions panel (HNV-11-06)', () => {
  it('says since when the live version is live, and when the others were retired', async () => {
    const html = await panel(presetPermissions('owner'));
    expect(textOf(item(html, 3))).toContain(
      `Live since ${formatDateTime('2026-10-04T09:00:00.000Z')}`,
    );
    expect(textOf(item(html, 1))).toContain(
      `Retired ${formatDateTime('2026-10-03T09:00:00.000Z')}`,
    );
    expect(item(html, 4)).not.toContain('data-testid="version-since"');
  });

  it('marks the version live before this one, and makes rolling back to it the obvious choice', async () => {
    const html = await panel(presetPermissions('owner'));
    expect(item(html, 2)).toContain('data-testid="previous-live"');
    expect(textOf(item(html, 2))).toContain('Live before this one');
    expect(item(html, 1)).not.toContain('data-testid="previous-live"');
    const button = (n: number) => item(html, n).match(/<button[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(textOf(button(2))).toBe('Roll back to version 2');
    expect(button(2)).toContain('data-variant="default"');
    expect(button(1)).toContain('data-variant="secondary"');
    // Neither the live version nor the draft offers a rollback.
    expect(button(3)).toBe('');
    expect(button(4)).toBe('');
  });

  it('offers a way to stop this agent’s replies at once, to people who can', async () => {
    const owner = await panel(presetPermissions('owner'));
    const stop = anchors(owner).find((a) => a.attrs['data-testid'] === 'versions-stop-ai');
    expect(stop?.href).toBe('/stop-ai');
    expect(stop?.text).toBe('Stop this agent’s replies at once');
    const reader = await panel(['agents.read']);
    expect(reader).not.toContain('data-testid="versions-stop-ai"');
    expect(reader).not.toContain('Roll back to version');
  });
});
