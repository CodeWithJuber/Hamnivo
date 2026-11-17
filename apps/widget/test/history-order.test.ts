import type { Message } from '@hamnivo/contracts';
import { describe, expect, it } from 'vitest';
import { inOrder, merge } from '../src/useChat.js';

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

  it('keeps a changed message in its place, never below later ones of the same second', () => {
    const at = '2026-10-09T10:00:05.000Z';
    const seq = (id: string, sequence: number | null) =>
      ({ id, createdAt: at, sequence }) as unknown as Message;
    const shown = [seq('answer', 7), seq('question', 8)];
    // Its next questions arrive as a change, with the change's own, later sequence.
    const changed = merge(shown, seq('answer', 12));
    expect(changed.map((m) => [m.id, m.sequence])).toEqual([
      ['answer', 7],
      ['question', 8],
    ]);
    // A message seen for the first time takes its own place.
    expect(merge(shown, seq('later', 9)).map((m) => m.id)).toEqual(['answer', 'question', 'later']);
  });
});
