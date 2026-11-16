import type { Message } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { type Custom, lastQuestion, toThread } from '../src/components/thread/model.js';

const ai = {
  kind: 'ai_agent',
  id: 'prt_ai',
  displayName: 'Noor Assistant',
  roleLabel: 'AI assistant',
};
const me = { kind: 'customer', id: 'prt_c', displayName: 'Customer' };

let minute = 0;
function message(id: string, sender: object, parts: unknown[]): Message {
  minute += 1;
  return {
    id,
    conversationId: 'cnv_1',
    sequence: minute,
    sender,
    visibility: 'public',
    parts,
    createdAt: new Date(Date.UTC(2026, 10, 4, 10, minute)).toISOString(),
    clientMessageId: null,
    delivery: null,
    language: 'en',
  } as unknown as Message;
}
const text = (value: string) => [{ type: 'text', text: value, format: 'plain' }];
const customOf = (thread: ReturnType<typeof toThread>, index: number) =>
  thread[index]?.metadata?.custom as unknown as Custom;

describe('the conversation as the thread shows it', () => {
  it('shows a reaction on the message it is for, not as a line of its own', () => {
    const messages = [
      message('msg_1', me, text('Where is my order?')),
      message('msg_2', ai, text('It ships today.')),
      message('msg_3', me, [{ type: 'reaction', emoji: '🙏', messageId: 'msg_2' }]),
    ];
    const thread = toThread(messages, [], 'You', null);
    expect(thread.map((m) => m.id)).toEqual(['msg_1', 'msg_2']);
    expect(customOf(thread, 1).reactions).toEqual(['🙏']);
    // A reaction is nothing to answer: the question stays the visitor's last word.
    expect(lastQuestion(messages)?.id).toBe('msg_1');
    expect(customOf(thread, 0).lastMine).toBe(true);
  });

  it('keeps a line for a reaction whose message is not loaded', () => {
    const thread = toThread(
      [message('msg_9', me, [{ type: 'reaction', emoji: '👍', messageId: 'msg_older' }])],
      [],
      'You',
      null,
    );
    expect(customOf(thread, 0).reaction).toEqual({ emoji: '👍' });
  });

  it('offers what to ask next only under the newest answer', () => {
    const next = { type: 'suggestions', items: ['Track it', '', 42, 'Change address'] };
    const older = message('msg_1', ai, [...text('Hello.'), next]);
    const question = message('msg_2', me, text('And delivery?'));
    const newest = message('msg_3', ai, [...text('Two days.'), next]);
    const thread = toThread([older, question, newest], [], 'You', null);
    expect(customOf(thread, 0).suggestions).toEqual([]);
    expect(customOf(thread, 2).suggestions).toEqual(['Track it', 'Change address']);
    expect(customOf(thread, 2).latest).toBe(true);
    // While the visitor's own message is on its way, the offer steps back.
    const sending = [
      { clientMessageId: 'c1', text: 'Thanks', state: 'sending', createdAt: Date.now() },
    ] as unknown as Parameters<typeof toThread>[1];
    const waiting = toThread([older, question, newest], sending, 'You', null);
    expect(customOf(waiting, 2).suggestions).toEqual([]);
    expect(waiting.at(-1)?.id).toBe('pending-c1');
  });

  it('gives back the same message for the same input, so its bubble is not drawn again', () => {
    const messages = [message('msg_1', me, text('Hi')), message('msg_2', ai, text('Hello.'))];
    const first = toThread(messages, [], 'You', null);
    const again = toThread([...messages], [], 'You', null);
    expect(again[0]).toBe(first[0]);
    expect(again[1]).toBe(first[1]);
    const more = toThread([...messages, message('msg_3', ai, text('More.'))], [], 'You', null);
    expect(more[0]).toBe(first[0]);
    // The earlier answer is no longer the newest, nor the end of its turn.
    expect(more[1]).not.toBe(first[1]);
    expect(customOf(more, 1).last).toBe(false);
  });

  it('names the sender by kind for the bubble, and the visitor in their own words', () => {
    const thread = toThread(
      [message('msg_1', me, text('Hi')), message('msg_2', ai, text('Hello.'))],
      [],
      'You',
      'msg_2',
    );
    expect(customOf(thread, 0)).toMatchObject({ kind: 'customer', name: 'You', first: true });
    expect(customOf(thread, 1)).toMatchObject({
      kind: 'ai_primary',
      name: 'Noor Assistant',
      role: 'AI assistant',
      firstUnread: true,
    });
  });
});
