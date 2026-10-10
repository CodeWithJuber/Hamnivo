import { describe, expect, it } from 'vitest';
import {
  answerState,
  type DirectoryRow,
  directoryRow,
  isFiltered,
  NO_FILTERS,
  rowMatches,
} from '../src/lib/agent-directory';
import type { Agent, AgentDetail } from '../src/lib/types';

const agent = (patch: Partial<Agent> = {}): Agent => ({
  id: 'agt_1',
  workspaceId: 'wsp_1',
  brandId: 'brd_1',
  name: 'Noor support',
  status: 'active',
  isDefault: true,
  publishedVersion: 2,
  draftVersion: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...patch,
});

const version = (config: Record<string, unknown>) =>
  ({
    config: {
      displayName: 'Noor assistant',
      purpose: 'Order questions and returns',
      mode: 'answer',
      model: { provider: 'openai', modelId: 'gpt-5-mini' },
      ...config,
    },
  }) as unknown as NonNullable<AgentDetail['published']>;

const detail = (
  published: Record<string, unknown> | null,
  draft: Record<string, unknown> | null = null,
): AgentDetail =>
  ({
    agent: agent(),
    published: published ? version(published) : null,
    draft: draft ? version(draft) : null,
  }) as AgentDetail;

describe('where an agent answers (as the gateway decides)', () => {
  it('only the brand’s default agent, once published, answers', () => {
    expect(answerState(agent(), 'answer')).toBe('customers');
    expect(answerState(agent(), 'assist')).toBe('assist');
    expect(answerState(agent(), undefined)).toBe('customers');
    expect(answerState(agent({ isDefault: false }), 'answer')).toBe('notDefault');
    expect(answerState(agent({ publishedVersion: null }), 'answer')).toBe('notLive');
    expect(answerState(agent({ isDefault: false, publishedVersion: null }), 'answer')).toBe(
      'notLive',
    );
    expect(answerState(agent({ status: 'archived' }), 'answer')).toBe('archived');
  });
});

describe('a directory row', () => {
  it('shows the model customers get, and the draft’s only when it differs', () => {
    const same = directoryRow(agent(), detail({}, {}), 'Noor Books');
    expect(same.liveModel).toEqual({ provider: 'openai', modelId: 'gpt-5-mini' });
    expect(same.draftModel).toBeUndefined();

    const changed = directoryRow(
      agent({ draftVersion: 3 }),
      detail({}, { model: { provider: 'anthropic', modelId: 'claude-x' } }),
      'Noor Books',
    );
    expect(changed.liveModel).toEqual({ provider: 'openai', modelId: 'gpt-5-mini' });
    expect(changed.draftModel).toEqual({ provider: 'anthropic', modelId: 'claude-x' });

    const draftOnly = directoryRow(agent({ publishedVersion: null }), detail(null, {}), 'B');
    expect(draftOnly.liveModel).toBeUndefined();
    expect(draftOnly.draftModel).toEqual({ provider: 'openai', modelId: 'gpt-5-mini' });
    expect(draftOnly.answer).toBe('notLive');
  });

  it('takes the purpose and name being worked on, and says when details are still loading', () => {
    const row = directoryRow(agent(), detail({}, { purpose: '  New purpose  ' }), 'B');
    expect(row.purpose).toBe('New purpose');
    expect(row.displayName).toBe('Noor assistant');
    expect(directoryRow(agent(), detail({ purpose: '   ' }), 'B').purpose).toBeUndefined();
    const loading = directoryRow(agent(), undefined, 'B');
    expect(loading.loading).toBe(true);
    expect(loading.answer).toBe('customers');
  });

  it('never carries the model connection or anything secret', () => {
    const row = directoryRow(
      agent(),
      detail({ model: { provider: 'openai', modelId: 'm', connectionId: 'mcn_secret' } }),
      'B',
    );
    expect(JSON.stringify(row)).not.toContain('mcn_secret');
  });
});

describe('finding an agent', () => {
  const rows: DirectoryRow[] = [
    directoryRow(agent(), detail({}), 'Noor Books'),
    directoryRow(
      agent({ id: 'agt_2', name: 'Returns bot', isDefault: false, brandId: 'brd_2' }),
      detail({ purpose: 'Refunds and exchanges', displayName: 'Returns helper' }),
      'Kitab Store',
    ),
    directoryRow(
      agent({ id: 'agt_3', name: 'Draft helper', publishedVersion: null }),
      detail(null, {}),
      'Noor Books',
    ),
  ];
  const ids = (filters: Partial<typeof NO_FILTERS>) =>
    rows.filter((row) => rowMatches(row, { ...NO_FILTERS, ...filters })).map((r) => r.agent.id);

  it('by every typed word, in its name, display name, purpose, brand or model', () => {
    expect(ids({})).toEqual(['agt_1', 'agt_2', 'agt_3']);
    expect(ids({ query: 'returns bot' })).toEqual(['agt_2']);
    expect(ids({ query: 'returns' })).toEqual(['agt_1', 'agt_2', 'agt_3']);
    expect(ids({ query: 'REFUNDS exchanges' })).toEqual(['agt_2']);
    expect(ids({ query: 'kitab' })).toEqual(['agt_2']);
    expect(ids({ query: 'gpt-5' })).toEqual(['agt_1', 'agt_2', 'agt_3']);
    expect(ids({ query: 'noor refunds' })).toEqual([]);
  });

  it('by brand, and by whether it answers now', () => {
    expect(ids({ brandId: 'brd_2' })).toEqual(['agt_2']);
    expect(ids({ state: 'answering' })).toEqual(['agt_1']);
    expect(ids({ state: 'idle' })).toEqual(['agt_2', 'agt_3']);
    expect(ids({ state: 'idle', brandId: 'brd_1' })).toEqual(['agt_3']);
  });

  it('knows when anything is filtered', () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, query: '  ' })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, query: 'x' })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, state: 'idle' })).toBe(true);
  });
});
