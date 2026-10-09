import type { Message } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { inOrder } from '../src/useChat.js';

const message = (id: string, createdAt: string): Message =>
  ({ id, createdAt, sequence: null }) as unknown as Message;

describe('history order', () => {
  it('keeps a question above its answer when both have the same second', () => {
    // The server lists newest first; Chatwoot keeps times to the second.
    const page = [
      message('answer', '2026-10-09T10:00:05.000Z'),
      message('question', '2026-10-09T10:00:05.000Z'),
      message('greeting', '2026-10-09T10:00:01.000Z'),
    ];
    expect(inOrder(page).map((m) => m.id)).toEqual(['greeting', 'question', 'answer']);
  });

  it('orders by time first', () => {
    const page = [
      message('later', '2026-10-09T10:00:09.000Z'),
      message('earlier', '2026-10-09T10:00:02.000Z'),
    ];
    expect(inOrder(page).map((m) => m.id)).toEqual(['earlier', 'later']);
  });
});
