import { describe, expect, it } from 'vitest';
import { applyRunEvent, type LiveRun, RUN_QUIET_MS, runIsLive } from '../src/run.js';

const activity = (kind: string, state: 'started' | 'finished', runId = 'run_1') => ({
  type: 'activity',
  data: { runId, kind, state, label: null },
});

function play(events: Array<{ type: string; data?: Record<string, unknown> }>, at = 1000) {
  return events.reduce<LiveRun | null>((run, event) => applyRunEvent(run, event, at), null);
}

describe('what the assistant is doing right now', () => {
  it('follows a run from its start through its steps to its end', () => {
    expect(play([activity('run', 'started')])).toEqual({
      runId: 'run_1',
      step: null,
      label: null,
      at: 1000,
    });
    expect(play([activity('run', 'started'), activity('searching', 'started')])?.step).toBe(
      'searching',
    );
    // A step that ends hands back to plain "working"; the run goes on.
    expect(
      play([
        activity('run', 'started'),
        activity('searching', 'started'),
        activity('searching', 'finished'),
      ]),
    ).toMatchObject({ runId: 'run_1', step: null });
    expect(play([activity('run', 'started'), activity('run', 'finished')])).toBeNull();
  });

  it('uses the gateway’s own words for a step it has none for', () => {
    const run = play([
      {
        type: 'activity',
        data: { runId: 'run_1', kind: 'inventory', state: 'started', label: 'Checking stock…' },
      },
    ]);
    expect(run).toMatchObject({ step: null, label: 'Checking stock…' });
  });

  it('takes words arriving as writing, even where no step said so', () => {
    const run = play([
      { type: 'message.delta', data: { runId: 'run_1', draftId: 'drf_1', index: 0 } },
    ]);
    expect(run?.step).toBe('writing');
  });

  it('ignores a late step of a run that is over', () => {
    const run = play([
      activity('run', 'started', 'run_2'),
      activity('checking', 'finished', 'run_1'),
      activity('run', 'finished', 'run_1'),
    ]);
    expect(run?.runId).toBe('run_2');
  });

  it('ends when the reply is published, a person takes over or the conversation closes', () => {
    const started = [activity('run', 'started')];
    const published = { message: { sender: { kind: 'ai_agent' } } };
    expect(play([...started, { type: 'message.created', data: published }])).toBeNull();
    const fromVisitor = { message: { sender: { kind: 'customer' } } };
    expect(play([...started, { type: 'message.created', data: fromVisitor }])).not.toBeNull();
    expect(
      play([...started, { type: 'conversation.updated', data: { responder: 'person' } }]),
    ).toBeNull();
    expect(
      play([...started, { type: 'conversation.updated', data: { responder: 'ai' } }]),
    ).not.toBeNull();
    expect(play([...started, { type: 'conversation.resolved' }])).toBeNull();
  });

  it('is no longer shown after a long silence, since live events are never replayed', () => {
    const run = play([activity('run', 'started')], 1000);
    expect(runIsLive(run, 1000 + RUN_QUIET_MS - 1)).toBe(true);
    expect(runIsLive(run, 1000 + RUN_QUIET_MS)).toBe(false);
    expect(runIsLive(null, 0)).toBe(false);
  });
});
