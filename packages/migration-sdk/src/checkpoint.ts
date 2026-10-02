/**
 * Checkpoint and retry rules for resumable imports (M07). Each object is one item with a status;
 * a write is recorded as `writing` before it is sent, so after a crash the job knows exactly which
 * write may have happened and looks it up instead of repeating it.
 */

export const ITEM_STATUSES = [
  'pending',
  'writing',
  'imported',
  'skipped',
  'quarantined',
  'failed',
  'rolled_back',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Attempts per object before it is marked failed (bounded retries). */
export const MAX_ITEM_ATTEMPTS = 5;

export type NextStep =
  /** Nothing to do. */
  | 'done'
  /** Send the write. */
  | 'write'
  /** A write may have happened: look it up by its key; send it only if it is not there. */
  | 'resolve'
  /** Out of attempts: mark it failed and move on. */
  | 'give_up';

export function nextStep(item: { status: ItemStatus; attempts: number }): NextStep {
  switch (item.status) {
    case 'pending':
      return item.attempts >= MAX_ITEM_ATTEMPTS ? 'give_up' : 'write';
    case 'writing':
      return item.attempts >= MAX_ITEM_ATTEMPTS ? 'give_up' : 'resolve';
    default:
      return 'done';
  }
}

export type FailureKind =
  /** Rejected; sending it again would fail the same way. */
  | 'permanent'
  /** Refused before anything happened (rate limit): wait and send again. */
  | 'retry'
  /** No answer or a server error: it may have been applied, so look it up before sending again. */
  | 'unknown';

/** Classifies an HTTP status (0 = no response: timeout or network). */
export function classifyStatus(status: number): FailureKind {
  if (status === 429) return 'retry';
  if (status === 0 || status === 408 || status >= 500) return 'unknown';
  return 'permanent';
}

/** Delay before the next attempt of a job slice, with full jitter, capped at five minutes. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const cap = Math.min(300_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(cap / 2 + random() * (cap / 2));
}

/**
 * Keeps writes to one conversation under a per-minute limit (Chatwoot allows 200 messages per
 * minute per conversation). `seed` restores the window after a restart, so a resumed job cannot
 * burst past the limit.
 */
export class Pacer {
  private sent: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    if (!Number.isInteger(perMinute) || perMinute < 1) {
      throw new RangeError('perMinute must be a positive integer');
    }
  }

  /** Recent send times (epoch ms) of the conversation, from any earlier run. */
  seed(times: readonly number[]): void {
    const since = this.now() - 60_000;
    this.sent = times.filter((t) => t > since).sort((a, b) => a - b);
  }

  reset(): void {
    this.sent = [];
  }

  /** Waits until one more write fits in the last minute, then counts it. Returns the wait. */
  async take(): Promise<number> {
    let waited = 0;
    for (;;) {
      const now = this.now();
      this.sent = this.sent.filter((t) => t > now - 60_000);
      if (this.sent.length < this.perMinute) {
        this.sent.push(now);
        return waited;
      }
      const oldest = this.sent[0] ?? now;
      const wait = Math.max(1, oldest + 60_000 - now);
      waited += wait;
      await this.sleep(wait);
    }
  }
}
