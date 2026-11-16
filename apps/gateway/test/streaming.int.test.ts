import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { createMockModel } from '@hamnivo/adapters/models';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * AI replies written live (AI_STREAM_REPLIES): what the assistant is doing and the draft's words
 * reach the customer's stream while the reply is written, as live-only events, and the published
 * reply replaces the draft. Stop and a takeover withdraw a draft the customer saw.
 */
const base = createMockModel();
/** While set, the model writes its first sentence and then waits for `release()`. */
let paused: { release: () => void; wait: Promise<void> } | null = null;
const pause = () => {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  paused = { release, wait };
  return paused;
};
/** What each model call was given, to check what the model saw. */
const prompts: unknown[] = [];
const model: LanguageModelV4 = {
  ...base,
  async doStream(call) {
    prompts.push(call.prompt);
    const hold = paused;
    paused = null;
    if (!hold) return base.doStream(call);
    const usage = {
      inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 12, text: 12, reasoning: 0 },
    };
    const parts: LanguageModelV4StreamPart[] = [
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Your order ' },
      { type: 'text-delta', id: 't', delta: 'ships today. ' },
    ];
    const rest: LanguageModelV4StreamPart[] = [
      { type: 'text-delta', id: 't', delta: 'It arrives on Thursday.' },
      { type: 'text-end', id: 't' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage } as never,
    ];
    let sent = false;
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        async pull(controller) {
          if (!sent) {
            sent = true;
            for (const part of parts) controller.enqueue(part);
            return;
          }
          await hold.wait;
          for (const part of rest) controller.enqueue(part);
          controller.close();
        },
      }),
    };
  },
};

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;

beforeAll(async () => {
  slice = await startSlice({ model, env: { AI_STREAM_REPLIES: 'true' } });
  shop = await connectedTenant(slice, 'stream');
});

afterAll(async () => {
  await slice?.close();
});

async function conversation(text: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: text,
  });
  expect(started.status).toBe(201);
  const id = started.body.id as string;
  const stream = visitor.stream(id, 0);
  // The customer's own message is there: the stream listens for live events from now on.
  await stream.until((s) => s.events.some((e) => e.type === 'message.created'));
  return { visitor, id, stream };
}

const live = (events: Array<Record<string, any>>, type: string) =>
  events.filter((e) => e.type === type);
const aiReplies = (events: Array<Record<string, any>>) =>
  live(events, 'message.created').filter((e) => e.data.message.sender.kind === 'ai_agent');

describe('a reply written live', () => {
  it('streams the steps and the words, then publishes the reply in their place', async () => {
    const { stream } = await conversation('Assalamu alaikum, where is my order?');
    await slice.drain();
    await stream.until((s) => aiReplies(s.events).length === 1);
    await stream.until((s) =>
      live(s.events, 'activity').some((e) => e.data.kind === 'run' && e.data.state === 'finished'),
    );
    const events = stream.events;
    const steps = live(events, 'activity').map((e) => `${e.data.kind} ${e.data.state}`);
    expect(steps[0]).toBe('run started');
    expect(steps).toContain('writing started');
    expect(steps).toContain('checking finished');
    expect(steps.at(-1)).toBe('run finished');
    const deltas = live(events, 'message.delta');
    expect(deltas.length).toBeGreaterThan(0);
    // Live-only: no sequence, so a reconnect never replays them.
    for (const event of [...deltas, ...live(events, 'activity')]) {
      expect(event.sequence).toBeNull();
      expect(event.lane).toBe('customer');
    }
    expect(deltas.map((e) => e.data.index)).toEqual(deltas.map((_, i) => i));
    expect(new Set(deltas.map((e) => e.data.draftId)).size).toBe(1);
    const draft = deltas.map((e) => e.data.textDelta).join('');
    const reply = aiReplies(events)[0]?.data.message.parts[0].text as string;
    expect(reply.startsWith(draft.trim().slice(0, 20))).toBe(true);
    // The words came before the published reply, and nothing was withdrawn.
    expect(events.indexOf(deltas[0] as never)).toBeLessThan(
      events.indexOf(aiReplies(events)[0] as never),
    );
    expect(live(events, 'message.draft_discarded')).toEqual([]);
    stream.close();
  });

  it('stops at the customer’s word: the draft goes at once and nothing is posted', async () => {
    const { visitor, id, stream } = await conversation('Where is my parcel?');
    const hold = pause();
    const draining = slice.drain();
    await stream.until((s) =>
      live(s.events, 'message.delta').some((e) => e.data.textDelta.includes('ships today')),
    );
    const stopped = await visitor.call('POST', `/v1/widget/conversations/${id}/reply/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body).toEqual({ stopped: true });
    await stream.until((s) => live(s.events, 'message.draft_discarded').length === 1);
    const discarded = live(stream.events, 'message.draft_discarded')[0];
    expect(discarded?.data.reason).toBe('cancelled');
    // Journaled, so a client that missed the live words still drops the draft.
    expect(typeof discarded?.sequence).toBe('number');
    hold.release();
    await draining;
    await slice.drain();
    expect(aiReplies(stream.events)).toEqual([]);
    expect(
      live(stream.events, 'message.delta').some((e) => e.data.textDelta.includes('Thursday')),
    ).toBe(false);
    // A second Stop finds nothing being written.
    const again = await visitor.call('POST', `/v1/widget/conversations/${id}/reply/stop`);
    expect(again.body).toEqual({ stopped: false });
    stream.close();
  });

  it('withdraws the draft when a person takes the conversation while it is written', async () => {
    const { id, stream } = await conversation('Can you check my order status?');
    const hold = pause();
    const draining = slice.drain();
    await stream.until((s) => live(s.events, 'message.delta').length > 0);
    const takeover = await shop.owner.post(`/v1/conversations/${id}/takeover`, {});
    expect(takeover.status).toBe(200);
    hold.release();
    await draining;
    await slice.drain();
    await stream.until((s) => live(s.events, 'message.draft_discarded').length === 1);
    expect(live(stream.events, 'message.draft_discarded')[0]?.data.reason).toBe('takeover');
    expect(aiReplies(stream.events)).toEqual([]);
    stream.close();
  });

  it('posts a reply the customer was reading when they wrote again, then answers the new message', async () => {
    const { visitor, id, stream } = await conversation('Where is my order?');
    const hold = pause();
    const draining = slice.drain();
    await stream.until((s) =>
      live(s.events, 'message.delta').some((e) => e.data.textDelta.includes('ships today')),
    );
    // The customer writes again while the first answer is still being written.
    const again = await visitor.call('POST', `/v1/widget/conversations/${id}/messages`, {
      clientMessageId: randomUUID(),
      parts: [{ type: 'text', text: 'And can I pay by card?' }],
    });
    expect(again.status).toBe(202);
    const before = prompts.length;
    hold.release();
    await draining;
    await slice.drain();
    await stream.until((s) => aiReplies(s.events).length === 2);
    const replies = aiReplies(stream.events).map((e) => e.data.message.parts[0].text as string);
    // What the customer read is what was posted; nothing was withdrawn as superseded.
    expect(replies[0]).toBe('Your order ships today. It arrives on Thursday.');
    expect(
      live(stream.events, 'message.draft_discarded').filter((e) => e.data.reason === 'superseded'),
    ).toEqual([]);
    // The new message's answer saw the first answer before it, and the new message last.
    const seen = JSON.stringify(prompts.at(-1));
    expect(prompts.length).toBe(before + 1);
    expect(seen.indexOf('It arrives on Thursday')).toBeGreaterThan(-1);
    expect(seen.indexOf('It arrives on Thursday')).toBeLessThan(
      seen.indexOf('And can I pay by card?'),
    );
    const last = (prompts.at(-1) as Array<{ role: string }>).at(-1);
    expect(last?.role).toBe('user');
    stream.close();
  });

  it('refuses Stop on a conversation that is not the visitor’s', async () => {
    const { id, stream } = await conversation('Hello?');
    stream.close();
    await slice.drain();
    const stranger = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await stranger.open();
    const refused = await stranger.call('POST', `/v1/widget/conversations/${id}/reply/stop`);
    expect(refused.status).toBe(404);
  });
});
