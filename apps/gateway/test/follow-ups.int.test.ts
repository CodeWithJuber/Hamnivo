import { randomUUID } from 'node:crypto';
import type { WidgetSettings } from '@hamnivo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * Questions the customer might ask next (AI_FOLLOW_UPS): written by the agent's model after an
 * answer is published, added to that answer as a `suggestions` part, and gone when the brand
 * switches them off.
 */
let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;

beforeAll(async () => {
  slice = await startSlice({ env: { AI_FOLLOW_UPS: 'true' } });
  shop = await connectedTenant(slice, 'followups');
});

afterAll(async () => {
  await slice?.close();
});

async function asked(text: string) {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const started = await visitor.call('POST', '/v1/widget/conversations', {
    clientMessageId: randomUUID(),
    firstMessage: text,
  });
  expect(started.status).toBe(201);
  const id = started.body.id as string;
  await slice.drain();
  const stream = visitor.stream(id, 0);
  return { visitor, id, stream };
}

const suggestionsOf = (message: { parts: Array<{ type: string; items?: string[] }> }) =>
  message.parts.find((part) => part.type === 'suggestions')?.items ?? null;

describe('follow-up questions', () => {
  it('adds up to three questions to the newest answer, live and in its history', async () => {
    const { visitor, id, stream } = await asked('Where is my order?');
    await stream.until((s) => s.events.some((e) => e.type === 'message.updated'));
    const events = stream.events;
    const answer = events.find(
      (e) => e.type === 'message.created' && e.data.message.sender.kind === 'ai_agent',
    );
    const updated = events.find((e) => e.type === 'message.updated');
    expect(updated?.data.message.id).toBe(answer?.data.message.id);
    expect(suggestionsOf(updated?.data.message)).toEqual([
      'When will my order arrive?',
      'Can I change the delivery address?',
    ]);
    // The answer itself is unchanged: same words, and the questions are not part of them.
    expect(updated?.data.message.parts[0]).toEqual(answer?.data.message.parts[0]);
    const history = await visitor.call('GET', `/v1/widget/conversations/${id}/messages?limit=10`);
    const reply = history.body.items.find(
      (m: { sender: { kind: string } }) => m.sender.kind === 'ai_agent',
    );
    expect(suggestionsOf(reply)).toEqual([
      'When will my order arrive?',
      'Can I change the delivery address?',
    ]);
    // Written once, however often the job runs.
    await slice.drain();
    expect(stream.events.filter((e) => e.type === 'message.updated')).toHaveLength(1);
    stream.close();
  });

  it('writes none when the brand switched them off', async () => {
    const current = await shop.owner.get(`/v1/admin/brands/${shop.brand.id}/widget-settings`);
    const saved = await shop.owner.put(`/v1/admin/brands/${shop.brand.id}/widget-settings`, {
      ...(current.body.settings as WidgetSettings),
      help: { ...(current.body.settings as WidgetSettings).help, followUps: false },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.settings.help.followUps).toBe(false);
    const { stream } = await asked('Do you ship abroad?');
    await stream.until((s) =>
      s.events.some(
        (e) => e.type === 'message.created' && e.data.message.sender.kind === 'ai_agent',
      ),
    );
    await slice.drain();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stream.events.filter((e) => e.type === 'message.updated')).toEqual([]);
    stream.close();
  });
});
