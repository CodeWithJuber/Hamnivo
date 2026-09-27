import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import { expect } from 'vitest';
import type { ModelErrorKind, ModelSpec } from '../../src/models/index.js';
import { type Captured, fixtureJson, fixtureText } from './harness.js';

export const SYSTEM = 'You are the support assistant for Noor Books. Be brief.';
const ASK = 'Assalamu alaikum, where is my order?';
const ANSWER = 'Wa alaikum assalam! Could you share the order number?';
const FOLLOW_UP = 'It is 1042.';

/** The system prompt and turns the gateway sends, as `generateText` takes them. */
export const TURNS: ModelMessage[] = [
  { role: 'user', content: ASK },
  { role: 'assistant', content: ANSWER },
  { role: 'user', content: FOLLOW_UP },
];

/** The same conversation as a provider receives it through `doGenerate` and `doStream`. */
export const PROMPT: LanguageModelV4Prompt = [
  { role: 'system', content: SYSTEM },
  { role: 'user', content: [{ type: 'text', text: ASK }] },
  { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
  { role: 'user', content: [{ type: 'text', text: FOLLOW_UP }] },
];

/** Prompt text that must never appear in a normalized error. */
export const PROMPT_TEXTS = [SYSTEM, ASK, ANSWER, FOLLOW_UP];

const REPLY = 'Order 1042 left our warehouse today. It should arrive on Thursday.';
const DELTAS = ['Order 1042 left', ' our warehouse today.', ' It should arrive on Thursday.'];

export type ErrorStatus = 401 | 429 | 500 | 503 | 529;

export interface ProviderKit {
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible';
  key: string;
  spec: ModelSpec;
  urls: { generate: string; stream: string };
  fixtures: { generate: unknown; stream: string; errors: Record<ErrorStatus, unknown> };
  expected: {
    text: string;
    deltas: string[];
    inputTokens: number;
    outputTokens: number;
    finishRaw: string;
    /** 500, 503 and 529 are all retryable; the kind depends on what the provider says. */
    serverKinds: Record<500 | 503 | 529, ModelErrorKind>;
  };
  assertAuth(request: Captured): void;
  assertStreamRequest(request: Captured): void;
  assertWire(body: any): void;
}

// 529 is Anthropic's overload status. The others never send it, but a proxy in front of them
// can, and the status alone must classify it; their 529 bodies reuse their own error envelope.

/**
 * Anthropic Messages API. Wire shapes from https://platform.claude.com/docs/en/api/messages,
 * https://platform.claude.com/docs/en/build-with-claude/streaming and
 * https://platform.claude.com/docs/en/api/errors.
 */
const anthropic: ProviderKit = {
  provider: 'anthropic',
  key: 'sk-ant-test-0000000000000000',
  spec: {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    apiKey: 'sk-ant-test-0000000000000000',
  },
  urls: {
    generate: 'https://api.anthropic.com/v1/messages',
    stream: 'https://api.anthropic.com/v1/messages',
  },
  fixtures: {
    generate: fixtureJson('anthropic', 'messages.json'),
    stream: fixtureText('anthropic', 'messages.sse'),
    errors: fixtureJson('anthropic', 'errors.json'),
  },
  expected: {
    text: REPLY,
    deltas: DELTAS,
    inputTokens: 52,
    outputTokens: 17,
    finishRaw: 'end_turn',
    serverKinds: { 500: 'unavailable', 503: 'unavailable', 529: 'overloaded' },
  },
  assertAuth(request) {
    expect(request.headers.get('x-api-key')).toBe(this.key);
    expect(request.headers.get('anthropic-version')).toBe('2023-06-01');
    expect(request.headers.get('authorization')).toBeNull();
  },
  assertStreamRequest(request) {
    expect(request.url.href).toBe(this.urls.stream);
    expect(request.body.stream).toBe(true);
  },
  assertWire(body) {
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toEqual(expect.any(Number));
    // The system prompt is a top-level field, never a message.
    expect(body.system).toEqual([{ type: 'text', text: SYSTEM }]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: ASK }] },
      { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
      { role: 'user', content: [{ type: 'text', text: FOLLOW_UP }] },
    ]);
  },
};

/**
 * OpenAI Chat Completions. Wire shapes from
 * https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
 * and https://developers.openai.com/api/docs/guides/error-codes.
 */
const openai: ProviderKit = {
  provider: 'openai',
  key: 'sk-test-0000000000000000',
  spec: { provider: 'openai', modelId: 'gpt-5.4-mini', apiKey: 'sk-test-0000000000000000' },
  urls: {
    generate: 'https://api.openai.com/v1/chat/completions',
    stream: 'https://api.openai.com/v1/chat/completions',
  },
  fixtures: {
    generate: fixtureJson('openai', 'chat-completion.json'),
    stream: fixtureText('openai', 'chat-completion.sse'),
    errors: fixtureJson('openai', 'errors.json'),
  },
  expected: {
    text: REPLY,
    deltas: DELTAS,
    inputTokens: 48,
    outputTokens: 16,
    finishRaw: 'stop',
    serverKinds: { 500: 'unavailable', 503: 'overloaded', 529: 'overloaded' },
  },
  assertAuth(request) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${this.key}`);
    expect(request.headers.get('x-api-key')).toBeNull();
  },
  assertStreamRequest(request) {
    expect(request.url.href).toBe(this.urls.stream);
    expect(request.body.stream).toBe(true);
    expect(request.body.stream_options).toEqual({ include_usage: true });
  },
  assertWire(body) {
    expect(body.model).toBe('gpt-5.4-mini');
    // GPT-5 models are reasoning models: "developer messages replace the previous system
    // messages" (chat completions reference above).
    expect(body.messages).toEqual([
      { role: 'developer', content: SYSTEM },
      { role: 'user', content: ASK },
      { role: 'assistant', content: ANSWER },
      { role: 'user', content: FOLLOW_UP },
    ]);
  },
};

/**
 * Gemini API generateContent. Wire shapes from https://ai.google.dev/api/generate-content; errors
 * are google.rpc.Status (https://google.aip.dev/193) with the statuses listed in
 * https://ai.google.dev/gemini-api/docs/troubleshooting.
 */
const google: ProviderKit = {
  provider: 'google',
  key: 'AIzaTest00000000000000000000000000000000',
  spec: {
    provider: 'google',
    modelId: 'gemini-3.8-flash',
    apiKey: 'AIzaTest00000000000000000000000000000000',
  },
  urls: {
    generate:
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    stream:
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
  },
  fixtures: {
    generate: fixtureJson('google', 'generate-content.json'),
    stream: fixtureText('google', 'stream-generate-content.sse'),
    errors: fixtureJson('google', 'errors.json'),
  },
  expected: {
    text: REPLY,
    deltas: DELTAS,
    inputTokens: 47,
    outputTokens: 15,
    finishRaw: 'STOP',
    serverKinds: { 500: 'unavailable', 503: 'overloaded', 529: 'overloaded' },
  },
  assertAuth(request) {
    // The SDK sends the key in x-goog-api-key (https://ai.google.dev/gemini-api/docs/api-key),
    // never as the `key` query parameter that would put it in proxy and access logs.
    expect(request.headers.get('x-goog-api-key')).toBe(this.key);
    expect(request.url.searchParams.has('key')).toBe(false);
    expect(request.headers.get('authorization')).toBeNull();
  },
  assertStreamRequest(request) {
    expect(request.url.href).toBe(this.urls.stream);
  },
  assertWire(body) {
    expect(body.systemInstruction).toEqual({ parts: [{ text: SYSTEM }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: ASK }] },
      { role: 'model', parts: [{ text: ANSWER }] },
      { role: 'user', parts: [{ text: FOLLOW_UP }] },
    ]);
  },
};

/**
 * An OpenAI-compatible server (Ollama here). The protocol is OpenAI's chat completions; the
 * response shapes follow https://docs.ollama.com/api/openai-compatibility.
 */
const compatible: ProviderKit = {
  provider: 'openai-compatible',
  key: 'ollama-test-0000000000000000',
  spec: {
    provider: 'openai-compatible',
    modelId: 'qwen3:8b',
    baseURL: 'https://llm.example.test/v1',
    apiKey: 'ollama-test-0000000000000000',
    name: 'ollama',
  },
  urls: {
    generate: 'https://llm.example.test/v1/chat/completions',
    stream: 'https://llm.example.test/v1/chat/completions',
  },
  fixtures: {
    generate: fixtureJson('openai-compatible', 'chat-completion.json'),
    stream: fixtureText('openai-compatible', 'chat-completion.sse'),
    errors: fixtureJson('openai-compatible', 'errors.json'),
  },
  expected: {
    text: REPLY,
    deltas: DELTAS,
    inputTokens: 51,
    outputTokens: 16,
    finishRaw: 'stop',
    serverKinds: { 500: 'unavailable', 503: 'unavailable', 529: 'overloaded' },
  },
  assertAuth(request) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${this.key}`);
  },
  assertStreamRequest(request) {
    expect(request.url.href).toBe(this.urls.stream);
    expect(request.body.stream).toBe(true);
    expect(request.body.stream_options).toEqual({ include_usage: true });
  },
  assertWire(body) {
    expect(body.model).toBe('qwen3:8b');
    expect(body.messages).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: ASK },
      { role: 'assistant', content: ANSWER },
      { role: 'user', content: FOLLOW_UP },
    ]);
  },
};

export const KITS: ProviderKit[] = [anthropic, openai, google, compatible];
