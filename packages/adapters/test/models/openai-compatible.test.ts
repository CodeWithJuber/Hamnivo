import { embedMany } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  capabilitiesOf,
  createEmbeddingModel,
  createLanguageModel,
  ModelConfigError,
  type ModelSpec,
} from '../../src/models/index.js';
import { fixtureJson, interceptProviders, json } from './harness.js';
import { KITS, PROMPT } from './kits.js';

const http = interceptProviders();
const kit = KITS.find((candidate) => candidate.provider === 'openai-compatible')!;
const generated = () => json(kit.fixtures.generate);

describe('openai-compatible', () => {
  it('embeds through the server /embeddings endpoint', async () => {
    const body = fixtureJson('openai-compatible', 'embeddings.json');
    const requests = http.reply(json(body));
    const result = await embedMany({
      model: createEmbeddingModel({ ...kit.spec, modelId: 'nomic-embed-text' }),
      values: ['Where is my order?', 'How do refunds work?'],
      maxRetries: 0,
    });

    expect(requests[0]?.url.href).toBe('https://llm.example.test/v1/embeddings');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${kit.key}`);
    expect(requests[0]?.body).toMatchObject({
      model: 'nomic-embed-text',
      input: ['Where is my order?', 'How do refunds work?'],
    });
    expect(result.embeddings).toEqual([body.data[0].embedding, body.data[1].embedding]);
  });

  it('sends no Authorization header when the server needs no key', async () => {
    const requests = http.reply(generated());
    const { apiKey: _, ...spec } = kit.spec;
    await createLanguageModel(spec).doGenerate({ prompt: PROMPT });
    expect(requests[0]?.headers.get('authorization')).toBeNull();
  });

  it('names the provider after the server', () => {
    expect(createLanguageModel(kit.spec).provider).toBe('ollama.chat');
    const { name: _, ...unnamed } = kit.spec;
    expect(createLanguageModel(unnamed).provider).toBe('openai-compatible.chat');
  });

  it('needs a base URL', () => {
    const { baseURL: _, ...spec } = kit.spec;
    expect(() => createLanguageModel(spec)).toThrow(ModelConfigError);
    expect(() => createEmbeddingModel(spec)).toThrow(/base URL/);
  });

  it('claims only streaming and embeddings until the operator declares more', () => {
    expect(capabilitiesOf(kit.spec)).toEqual({
      streaming: true,
      toolCalls: false,
      structuredOutput: false,
      embeddings: true,
      imageInput: false,
    });
    const declared: ModelSpec = {
      ...kit.spec,
      capabilities: { toolCalls: true, structuredOutput: true, embeddings: false },
    };
    expect(capabilitiesOf(declared)).toMatchObject({
      toolCalls: true,
      structuredOutput: true,
      embeddings: false,
    });
    expect(() => createEmbeddingModel(declared)).toThrow(/do not support embeddings/);
  });

  it('asks for schema-constrained output only when the server is declared to support it', async () => {
    const responseFormat = {
      type: 'json' as const,
      name: 'order',
      schema: {
        type: 'object' as const,
        properties: { orderId: { type: 'string' as const } },
        required: ['orderId'],
      },
    };
    const requests = http.reply(generated());
    await createLanguageModel(kit.spec).doGenerate({ prompt: PROMPT, responseFormat });
    await createLanguageModel({
      ...kit.spec,
      capabilities: { structuredOutput: true },
    }).doGenerate({ prompt: PROMPT, responseFormat });

    expect(requests[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(requests[1]?.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'order', schema: responseFormat.schema },
    });
  });
});
