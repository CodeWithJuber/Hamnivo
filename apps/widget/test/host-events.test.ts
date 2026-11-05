import { describe, expect, it } from 'vitest';
import { type ChatSnapshot, eventsBetween, snapshotOf } from '../src/hostEvents.js';

const none: ChatSnapshot = {
  conversationId: null,
  status: null,
  lastReplyId: null,
  lastReplyFrom: null,
  error: null,
};
const open = (patch: Partial<ChatSnapshot> = {}): ChatSnapshot => ({
  ...none,
  conversationId: 'cnv_1',
  status: 'open',
  ...patch,
});
const names = (events: { event: string }[]) => events.map((e) => e.event);

describe('what the website hears about the chat (Hamnivo.on)', () => {
  it('a new conversation is started; opening one the visitor had is not', () => {
    expect(eventsBetween(none, open(), new Set())).toEqual([
      { event: 'conversation.started', payload: { conversationId: 'cnv_1' } },
    ]);
    expect(eventsBetween(none, open(), new Set(['cnv_1']))).toEqual([]);
  });

  it('reports asking for a person, a person joining and the end of the chat', () => {
    const waiting = open({ status: 'waiting_for_person' });
    expect(names(eventsBetween(open(), waiting, new Set()))).toEqual(['handoff.requested']);
    expect(names(eventsBetween(waiting, open({ status: 'with_person' }), new Set()))).toEqual([
      'handoff.accepted',
    ]);
    expect(names(eventsBetween(open(), open({ status: 'resolved' }), new Set()))).toEqual([
      'conversation.resolved',
    ]);
  });

  it('says who replied, never what they wrote', () => {
    const events = eventsBetween(
      open(),
      open({ lastReplyId: 'msg_2', lastReplyFrom: 'person' }),
      new Set(),
    );
    expect(events).toEqual([
      { event: 'message', payload: { conversationId: 'cnv_1', from: 'person' } },
    ]);
  });

  it('switching conversations reports neither a status change nor a reply', () => {
    const other = open({ conversationId: 'cnv_2', status: 'resolved', lastReplyId: 'msg_9' });
    expect(eventsBetween(open(), other, new Set(['cnv_2']))).toEqual([]);
  });

  it('reports a failure to start once', () => {
    const failed = { ...none, error: 'chat_offline' };
    expect(eventsBetween(none, failed, new Set())).toEqual([
      { event: 'error', payload: { code: 'chat_offline' } },
    ]);
    expect(eventsBetween(failed, failed, new Set())).toEqual([]);
  });

  it('takes the newest reply from the brand, skipping the visitor’s own messages', () => {
    const message = (id: string, kind: string) =>
      ({ id, sender: { kind, displayName: '' } }) as never;
    const snapshot = snapshotOf({
      conversation: { id: 'cnv_1', status: 'open' } as never,
      messages: [
        message('m1', 'ai_agent'),
        message('m2', 'human_agent'),
        message('m3', 'customer'),
      ],
      phase: 'ready',
      error: null,
    });
    expect(snapshot).toMatchObject({ lastReplyId: 'm2', lastReplyFrom: 'person', error: null });
  });
});
