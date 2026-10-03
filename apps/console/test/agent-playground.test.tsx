import { AnnouncerProvider } from '@hamnivo/ui/components/live-region';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentPlayground, PlaygroundAnswer } from '../src/components/agent/AgentPlayground';
import { initI18n } from '../src/i18n';
import type { PlaygroundResult, PlaygroundStep } from '../src/lib/ai-power';
import { renderStudio, textOf } from './render';

beforeAll(async () => {
  await initI18n('en');
});

const MANAGER = ['agents.read', 'agents.manage'];

const playground = (
  props: Partial<Parameters<typeof AgentPlayground>[0]> = {},
  permissions: readonly string[] = MANAGER,
) =>
  renderStudio({
    at: '/agents/agt_1',
    permissions,
    screen: (
      <AnnouncerProvider>
        <AgentPlayground
          agentId="agt_1"
          draftVersion={3}
          publishedVersion={2}
          unsaved={false}
          {...props}
        />
      </AnnouncerProvider>
    ),
  });

const step = (
  seq: number,
  overrides: Pick<PlaygroundStep, 'kind' | 'name' | 'status'> & Partial<PlaygroundStep>,
): PlaygroundStep => ({
  seq,
  provider: null,
  modelId: null,
  inputTokens: null,
  outputTokens: null,
  latencyMs: null,
  detail: {},
  ...overrides,
});

const replied: PlaygroundResult = {
  outcome: 'replied',
  reply: 'You can return unworn items within thirty days [1].',
  handoffReason: null,
  errorKind: null,
  version: { number: 3, state: 'draft' },
  model: { provider: 'openai-compatible', modelId: 'test-model' },
  inputTokens: 120,
  outputTokens: 18,
  latencyMs: 1450,
  sources: [
    {
      documentId: 'doc_1',
      title: 'Returns policy',
      heading: 'Returns',
      url: 'https://noor.example/returns',
      excerpt: 'You can return unworn items within thirty days of delivery.',
    },
  ],
  actions: [
    {
      tool: 'demo_update_address',
      title: 'Change delivery address',
      decision: 'needs_approval',
      reason: 'customer_approval',
      arguments: { orderReference: 'NL-1048', address: '2 Palm Road' },
    },
    {
      tool: 'order_status',
      title: 'Read order status',
      decision: 'would_run',
      reason: null,
      arguments: { orderReference: 'NL-1048' },
    },
  ],
  steps: [
    step(0, {
      kind: 'retrieval',
      name: 'knowledge',
      status: 'ok',
      latencyMs: 12,
      detail: { passages: 1 },
    }),
    step(1, {
      kind: 'model',
      name: 'generate',
      status: 'ok',
      provider: 'openai-compatible',
      modelId: 'test-model',
      inputTokens: 120,
      outputTokens: 18,
      latencyMs: 1400,
      detail: { finishReason: 'stop', attempt: 0 },
    }),
    step(2, {
      kind: 'guard',
      name: 'honest_identity',
      status: 'blocked',
      detail: { rule: 'en.claims_human' },
    }),
  ],
};

const answer = async (result: PlaygroundResult) =>
  renderStudio({
    at: '/agents/agt_1',
    permissions: MANAGER,
    screen: <PlaygroundAnswer result={result} />,
  });

describe('Test your AI', () => {
  it('invites a conversation with the agent, and says nothing is saved or sent', async () => {
    const html = await playground();
    const text = textOf(html);
    expect(text).toContain('Test your AI');
    expect(text).toContain(
      'Nothing is saved, nothing reaches a customer or the inbox, and no tool is run.',
    );
    expect(text).toContain('Test only: nothing is sent or saved');
    expect(text).toContain('Write a message to start.');
    expect(html).toContain('role="log"');
    expect(html).toContain('data-testid="playground-transcript"');
    // Nothing to send yet, and nothing to start over.
    expect(html.match(/<button\b[^>]*type="submit"[^>]*>/)?.[0]).toContain('disabled');
  });

  it('offers the saved draft and the live version, and starts with the draft', async () => {
    const html = await playground();
    expect(html).toContain('Saved draft (version 3)');
    expect(html).toContain('Live version (2)');
    expect(html).toMatch(
      /<option[^>]*value="draft"[^>]*selected|<select[^>]*>[\s\S]*?value="draft"/,
    );
    const live = await playground({ draftVersion: undefined });
    expect(live).not.toContain('Saved draft');
    expect(live).toContain('Live version (2)');
    const draftOnly = await playground({ publishedVersion: null });
    expect(draftOnly).toContain('Saved draft (version 3)');
    expect(draftOnly).not.toContain('Live version');
  });

  it('warns that unsaved changes are not what is tested', async () => {
    expect(textOf(await playground({ unsaved: true }))).toContain(
      'Some changes are not saved. The test uses the saved draft',
    );
    expect(textOf(await playground({ unsaved: false }))).not.toContain(
      'Some changes are not saved',
    );
    // Trying the live version is unaffected by the form.
    const live = await playground({ unsaved: true, draftVersion: undefined });
    expect(textOf(live)).not.toContain('Some changes are not saved');
  });

  it('asks for a draft when there is nothing to try', async () => {
    const html = await playground({ draftVersion: undefined, publishedVersion: null });
    expect(textOf(html)).toContain('Save a draft to try this agent.');
    expect(html).not.toContain('playground-message');
  });

  it('is only for people who can manage agents', async () => {
    const html = await playground({}, ['agents.read']);
    expect(html).not.toContain('data-testid="playground"');
    expect(textOf(html)).not.toContain('Test your AI');
  });
});

describe('what the AI answered', () => {
  it('shows the reply, the sources it cites and the model that wrote it', async () => {
    const html = await answer(replied);
    const text = textOf(html);
    expect(html).toContain('data-testid="playground-reply"');
    expect(text).toContain('You can return unworn items within thirty days [1].');
    expect(text).toContain('Sources it used');
    expect(text).toContain('[1] Returns policy · Returns');
    expect(html).toContain('href="https://noor.example/returns"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(text).toContain('Model openai-compatible / test-model · tokens 120 in, 18 out');
  });

  it('says what each tool would have done, and that none was run', async () => {
    const html = await answer(replied);
    const text = textOf(html);
    expect(text).toContain('Tools are never run here.');
    expect(text).toContain('Change delivery address');
    expect(text).toContain('Would ask for approval');
    expect(text).toContain('Read order status');
    expect(text).toContain('Would run now');
    expect(html).toContain('data-decision="needs_approval"');
    expect(html).toContain('2 Palm Road');
  });

  it('lists every step with its kind, outcome, model, tokens and facts', async () => {
    const html = await answer(replied);
    expect(textOf(html)).toContain('Steps (3)');
    expect(html.match(/data-step="(retrieval|model|guard)"/g)).toEqual([
      'data-step="retrieval"',
      'data-step="model"',
      'data-step="guard"',
    ]);
    const steps = textOf(html.slice(html.indexOf('data-testid="playground-steps"')));
    expect(steps).toContain('Knowledge search');
    expect(steps).toContain('Model');
    expect(steps).toContain('Guard');
    expect(steps).toContain('Blocked');
    expect(steps).toContain('openai-compatible / test-model');
    expect(steps).toContain('finishReason');
    expect(steps).toContain('en.claims_human');
  });

  it('says why a live chat would go to people', async () => {
    const handoff = (reason: string | null) =>
      answer({
        ...replied,
        outcome: reason === 'ai_blocked' ? 'blocked' : 'handoff',
        reply: null,
        handoffReason: reason,
        model: null,
        inputTokens: null,
        outputTokens: null,
        sources: [],
        actions: [],
        steps: [],
      });
    const person = textOf(await handoff('customer_request'));
    expect(person).toContain('The customer asked for a person');
    expect(person).toContain('No model was called');
    expect(textOf(await handoff('assist_mode'))).toContain('only suggests replies');
    expect(textOf(await handoff('ai_blocked'))).toContain(
      'could not write a reply that follows its rules',
    );
    expect(textOf(await handoff('something_new'))).toContain(
      'A live chat would go to your team here.',
    );
  });

  it('explains a model that did not answer in words, never in what the provider said', async () => {
    const failed = (kind: string | null) =>
      answer({
        ...replied,
        outcome: 'error',
        reply: null,
        errorKind: kind,
        sources: [],
        actions: [],
        steps: [],
      });
    const html = await failed('auth');
    expect(html).toContain('data-testid="playground-error"');
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('The model provider refused the key or the account.');
    expect(textOf(await failed('connection_disabled'))).toContain('The model connection is off.');
    expect(textOf(await failed('a_kind_nobody_wrote_words_for'))).toContain(
      'The model did not answer.',
    );
    expect(textOf(await failed(null))).toContain('The model did not answer.');
  });

  it('shows what the AI wrote as text, in its own direction', async () => {
    const html = await answer({
      ...replied,
      reply: '<img src=x onerror=alert(1)> مرحبا',
      sources: [
        { ...replied.sources[0], title: '<script>alert(1)</script>', url: null },
      ] as PlaygroundResult['sources'],
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toMatch(
      /<p[^>]*dir="auto"[^>]*data-testid="playground-reply"|data-testid="playground-reply"[^>]*dir="auto"|dir="auto"[^>]*>&lt;img/,
    );
  });
});
