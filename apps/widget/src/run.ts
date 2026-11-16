/**
 * What the assistant is doing right now, from the conversation's live `activity` events: real
 * steps ("searching the help articles", "writing"), never a guess and never private reasoning.
 * A run starts and ends with an activity of kind `run`; in between, each step that starts is the
 * one shown, and a step that finishes hands back to plain "working". Live events are not
 * replayed, so a run also ends when its reply is published, when people take the conversation,
 * or after a quiet spell (see `RUN_QUIET_MS`).
 */

/** What a step is, so the chat can say it in the visitor's language; unknown kinds use `label`. */
export type RunStep = 'searching' | 'tool' | 'writing' | 'checking';

export interface LiveRun {
  runId: string;
  /** The step in progress, or null between steps. */
  step: RunStep | null;
  /** The gateway's own words for the step, used when the chat has none for its kind. */
  label: string | null;
  /** When the chat last heard of this run (ms). */
  at: number;
}

export interface RunEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Without any word of a run for this long, it is no longer shown as working. */
export const RUN_QUIET_MS = 90_000;

const STEPS: ReadonlySet<string> = new Set(['searching', 'tool', 'writing', 'checking']);
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

/** The live run after one event; unrelated events change nothing. */
export function applyRunEvent(run: LiveRun | null, event: RunEvent, now: number): LiveRun | null {
  const data = event.data ?? {};
  switch (event.type) {
    case 'activity': {
      const runId = text(data.runId);
      if (!runId) return run;
      const kind = text(data.kind) ?? '';
      if (data.state === 'finished') {
        // The run itself is over, or an older run's late step: nothing of it is shown.
        if (kind === 'run') return run?.runId === runId ? null : run;
        if (run?.runId !== runId) return run;
        return { ...run, step: null, label: null, at: now };
      }
      if (data.state !== 'started') return run;
      if (kind === 'run') return { runId, step: null, label: null, at: now };
      return {
        runId,
        step: STEPS.has(kind) ? (kind as RunStep) : null,
        label: text(data.label),
        at: now,
      };
    }
    case 'message.delta': {
      // Words arriving are a sign of life, and of writing, even where no step said so.
      const runId = text(data.runId);
      if (!runId) return run;
      return run?.runId === runId && run.step === 'writing'
        ? { ...run, at: now }
        : { runId, step: 'writing', label: null, at: now };
    }
    case 'message.created': {
      const message = data.message as { sender?: { kind?: string } } | undefined;
      return message?.sender?.kind === 'ai_agent' ? null : run;
    }
    case 'conversation.updated':
      return data.responder !== 'ai' ? null : run;
    case 'conversation.resolved':
      return null;
    default:
      return run;
  }
}

/** Whether a run is still to be shown at `now`. */
export const runIsLive = (run: LiveRun | null, now: number): run is LiveRun =>
  run !== null && now - run.at < RUN_QUIET_MS;
