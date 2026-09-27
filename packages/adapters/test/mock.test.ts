import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { createMockModel, defaultMockReply } from '../src/models/index.js';

describe('hamnivo-mock', () => {
  it('works with generateText and answers in the customer script', async () => {
    const model = createMockModel();
    const latin = await generateText({
      model,
      system: 'Be kind.',
      prompt: 'Assalamu alaikum, where is my order?',
    });
    expect(latin.text).toMatch(/^Wa alaikum assalam! /);
    expect(latin.text).toContain('AI assistant');
    expect(latin.usage.outputTokens).toBeGreaterThan(5);

    const urdu = await generateText({ model, prompt: 'السلام علیکم، میرا آرڈر کہاں ہے؟' });
    expect(urdu.text).toMatch(/^وعلیکم السلام! /);
    const arabic = await generateText({ model, prompt: 'السلام عليكم، أين طلبي؟' });
    expect(arabic.text).toMatch(/^وعليكم السلام! /);
    const hindi = await generateText({ model, prompt: 'मेरा ऑर्डर कहाँ है?' });
    expect(hindi.text).toContain('एआई सहायक');
  });

  it('streams the same text in chunks and is deterministic', async () => {
    const model = createMockModel();
    const result = streamText({ model, prompt: 'Hello' });
    const chunks: string[] = [];
    for await (const delta of result.textStream) chunks.push(delta);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toBe(defaultMockReply({ system: '', text: 'Hello', turn: 1 }));
  });

  it('accepts a scripted reply and respects cancellation', async () => {
    const model = createMockModel({ reply: ({ turn, text }) => `#${turn}: ${text.toUpperCase()}` });
    const out = await generateText({
      model,
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second' },
      ],
    });
    expect(out.text).toBe('#2: SECOND');
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateText({ model, prompt: 'x', abortSignal: controller.signal, maxRetries: 0 }),
    ).rejects.toThrow();
  });
});
