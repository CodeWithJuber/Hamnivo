import { randomUUID } from 'node:crypto';
import type { ActivityKind } from '@hamnivo/contracts';
import type { RunSignals } from './run-signals.js';
import { SentenceGate } from './stream-gate.js';

/** Why a draft the customer saw will not become the reply (`message.draft_discarded`). */
export type DiscardReason = 'takeover' | 'cancelled' | 'failed' | 'superseded' | 'check_failed';

export interface LiveReplyDeps {
  signals: Pick<RunSignals, 'publish'>;
  /** Journals that a draft was withdrawn, so a client that missed the live signals still drops it. */
  discard: (draftId: string, reason: DiscardReason) => Promise<void>;
  /** Whether what would be shown so far passes the deterministic checks (see SentenceGate). */
  passes: (text: string) => boolean;
}

/**
 * One AI reply while it is written, as the customer sees it: which step it is at (`activity`),
 * and, where the brand's checks allow, its words as a draft (`message.delta`). Every step started
 * is finished, and a draft that will not be published is withdrawn, whatever way the reply ends
 * (`close`). With `words` off (a live answer check or message guard could still hold the reply
 * back) only the steps are said.
 */
export class LiveReply {
  private draftId = randomUUID();
  private index = 0;
  private gate: SentenceGate;
  /** Words of the current draft went out. */
  private shown = false;
  private readonly open = new Set<ActivityKind>();
  private stopped = false;
  /** Ending: no more words. */
  private closing = false;
  /** Ended: no more signals at all. */
  private closed = false;
  /** Why the reply did not go out, when it did not; set by the paths that end it. */
  reason: DiscardReason = 'failed';
  private published = false;
  /** Signals go out in order, one at a time. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: LiveReplyDeps,
    readonly tenantId: string,
    readonly conversationId: string,
    /** The run's public id, as the customer's events name it. */
    readonly runId: string,
    /** Words may go out; decided once the run's checks are known (steps go out either way). */
    public words: boolean,
    /** Nothing goes out at all (AI_STREAM_REPLIES off): the reply arrives whole, as before. */
    private readonly muted = false,
  ) {
    this.gate = new SentenceGate(deps.passes);
  }

  /** The draft being written, for the reply that publishes it. */
  get currentDraft(): string | null {
    return this.shown ? this.draftId : null;
  }

  private send(signal: Parameters<RunSignals['publish']>[2]) {
    if (this.muted) return this.queue;
    this.queue = this.queue.then(() =>
      this.deps.signals.publish(this.tenantId, this.conversationId, signal),
    );
    return this.queue;
  }

  /** A step starts or ends; repeated starts and ends of the same step are said once. */
  step(kind: ActivityKind, state: 'started' | 'finished'): Promise<void> {
    if (this.closed) return this.queue;
    if (state === 'started' ? this.open.has(kind) : !this.open.has(kind)) return this.queue;
    if (state === 'started') this.open.add(kind);
    else this.open.delete(kind);
    return this.send({ type: 'activity', data: { runId: this.runId, kind, label: '', state } });
  }

  /** Words the model wrote; whole sentences that pass go out as the draft. */
  write(delta: string): void {
    if (this.muted || !this.words || this.stopped || this.closing) return;
    this.emit(this.gate.push(delta));
  }

  /** The model finished this attempt: the rest of the draft, if it passes. */
  end(): void {
    if (!this.words || this.stopped || this.closing) return;
    this.emit(this.gate.end());
  }

  private emit(text: string) {
    if (!text) return;
    if (!this.shown) void this.step('writing', 'started');
    this.shown = true;
    const index = this.index;
    this.index += 1;
    void this.send({
      type: 'message.delta',
      data: { runId: this.runId, draftId: this.draftId, index, textDelta: text },
    });
  }

  /**
   * What was written so far will not be the reply (a tool call follows, or a check asked for it
   * to be written again): the draft is withdrawn and the next words start a new one.
   */
  async restart(reason: DiscardReason): Promise<void> {
    await this.withdraw(reason);
    this.draftId = randomUUID();
    this.index = 0;
    this.gate = new SentenceGate(this.deps.passes);
  }

  /** The customer pressed Stop: nothing more is shown, and what was shown goes. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.reason = 'cancelled';
    await this.withdraw('cancelled');
  }

  /** The reply was published: its draft becomes the message, nothing is withdrawn. */
  markPublished(): void {
    this.published = true;
  }

  /** Ends the run as the customer sees it: every step finished, an unpublished draft withdrawn. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (!this.published) await this.withdraw(this.reason).catch(() => undefined);
    for (const kind of [...this.open]) if (kind !== 'run') await this.step(kind, 'finished');
    await this.step('run', 'finished');
    this.closed = true;
    await this.queue;
  }

  private async withdraw(reason: DiscardReason) {
    if (!this.shown) return;
    this.shown = false;
    await this.step('writing', 'finished');
    await this.queue;
    await this.deps.discard(this.draftId, reason);
  }
}
