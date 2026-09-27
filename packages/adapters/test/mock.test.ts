import { MEMORY_EXTRACTION_MARKER } from '@hamnivo/domain';
import { generateText, Output, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('answers memory extraction with explicit statements only, as structured output', async () => {
    const schema = z.object({
      memories: z.array(
        z.object({
          key: z.string(),
          value: z.string(),
          evidence: z.string(),
          sourceRef: z.string(),
          confidence: z.enum(['high', 'medium', 'low']),
          basis: z.enum(['stated', 'inferred']),
        }),
      ),
    });
    const extract = (messages: Array<{ ref: string; text: string }>) =>
      generateText({
        model: createMockModel(),
        instructions: `${MEMORY_EXTRACTION_MARKER}\nFind what the customer asked to be remembered.`,
        messages: [
          {
            role: 'user',
            content: JSON.stringify({
              messages: messages.map((m) => ({ ...m, at: '2026-09-27T10:00:00Z' })),
            }),
          },
        ],
        output: Output.object({ schema }),
      });
    const found = await extract([
      { ref: 'msg_1', text: 'Where is my parcel?' },
      { ref: 'msg_2', text: 'Please answer in Urdu from now on.' },
    ]);
    expect(found.output.memories).toEqual([
      {
        key: 'preferred_language',
        value: 'Urdu',
        evidence: 'answer in Urdu',
        sourceRef: 'msg_2',
        confidence: 'high',
        basis: 'stated',
      },
    ]);
    expect((await extract([{ ref: 'msg_1', text: 'Thanks!' }])).output.memories).toEqual([]);
  });

  it('mentions a customer memory it was given as a memory, with its citation', () => {
    const system = [
      'Be kind.',
      '<customer_memories>',
      '[M1] Preferred language: Urdu (customer message, 2026-09-20)',
      '</customer_memories>',
    ].join('\n');
    expect(defaultMockReply({ system, text: 'Where is my parcel?', turn: 1 })).toMatch(
      / You told us before that your preferred language is Urdu \[M1\]\.$/,
    );
    expect(
      defaultMockReply({ system: 'Be kind.', text: 'Where is my parcel?', turn: 1 }),
    ).not.toContain('[M1]');
  });
});
