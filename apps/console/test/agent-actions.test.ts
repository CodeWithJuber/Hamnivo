import { AgentConfig } from '@hamnivo/contracts';
import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n } from '../src/i18n';
import { differences, sameConfig, toConfig, toForm } from '../src/lib/agent-form';

beforeAll(async () => {
  await initI18n('en');
});

/** As the gateway returns a configuration: parsed, with every default filled in. */
const config = (patch: Record<string, unknown> = {}) =>
  AgentConfig.parse({
    displayName: 'AI assistant',
    model: {
      provider: 'openai',
      modelId: 'gpt-5.4-mini',
      connectionId: 'mcn_01j9zk7w3xq8r4t2v6m5n1p0cd',
    },
    ...patch,
  });

describe('the assistant’s actions in the agent editor', () => {
  it('keeps them through an edit, so saving something else never turns them off', () => {
    const live = config({ actions: { handoff: true, choices: true, contact: true, search: true } });
    const form = toForm(live);
    expect(form.actions).toEqual({ handoff: true, choices: true, contact: true, search: true });
    const saved = toConfig({ ...form, purpose: 'Help Noor Books customers.' }, i18next.t);
    expect(saved.config?.actions).toEqual(live.actions);
    // Unchanged, the form gives back exactly what the gateway sent.
    const same = toConfig(form, i18next.t);
    expect(same.config && sameConfig(same.config, live)).toBe(true);
  });

  it('starts them off for an agent saved before they existed, and names a change to them', () => {
    const old = toForm(config());
    expect(old.actions).toEqual({ handoff: false, choices: false, contact: false, search: false });
    expect(differences(old, { ...old, actions: { ...old.actions, handoff: true } })).toEqual([
      'actions',
    ]);
  });
});
