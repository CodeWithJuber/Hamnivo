import { describe, expect, it } from 'vitest';
import { applyDraftEvent, type Draft, draftText } from '../src/drafts.js';

const delta = (index: number, textDelta: string, draftId = 'drf_1') => ({
  type: 'message.delta',
  data: { runId: 'run_1', draftId, index, textDelta },
});

function play(events: Array<{ type: string; data?: Record<string, unknown> }>) {
  return events.reduce<readonly Draft[]>((drafts, event) => applyDraftEvent(drafts, event), []);
}

describe('draft replies before publication', () => {
  it('builds a provisional draft from its pieces, in order, ignoring repeats', () => {
    const drafts = play([delta(0, 'Returns take '), delta(1, '90 days.'), delta(1, 'garbled')]);
    expect(drafts).toHaveLength(1);
    expect(draftText(drafts[0] as Draft)).toBe('Returns take 90 days.');
  });

  it('removes a draft the answer check withdrew, so nothing of it stays on screen', () => {
    const drafts = play([
      delta(0, 'Returns take 90 days [1].'),
      {
        type: 'message.draft_discarded',
        data: { runId: 'run_1', draftId: 'drf_1', reason: 'check_failed' },
      },
    ]);
    expect(drafts).toEqual([]);
  });

  it('replaces the draft with the published reply', () => {
    const drafts = play([
      delta(0, 'You can return unworn items within 30 days [1].'),
      { type: 'message.created', data: { message: { sender: { kind: 'customer' } } } },
    ]);
    expect(drafts).toHaveLength(1);
    expect(
      applyDraftEvent(drafts, {
        type: 'message.created',
        data: { message: { sender: { kind: 'ai_agent' } } },
      }),
    ).toEqual([]);
  });

  it('drops AI drafts when a person takes over', () => {
    const drafts = play([delta(0, 'Draft')]);
    expect(
      applyDraftEvent(drafts, {
        type: 'conversation.updated',
        data: { status: 'with_person', responder: 'person' },
      }),
    ).toEqual([]);
    expect(applyDraftEvent(drafts, { type: 'typing', data: {} })).toBe(drafts);
  });
});
