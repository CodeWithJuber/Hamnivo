import type { Message } from '@hamnivo/contracts';
import type { HamnivoClient } from './client.js';
import type { HamnivoApiError } from './errors.js';

export type OutgoingState = 'queued' | 'sending' | 'accepted' | 'failed';

/** A file already scanned by the gateway that travels with a message (W09). */
export interface OutgoingAttachment {
  uploadId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface OutgoingMessage {
  clientMessageId: string;
  text: string;
  /** Files sent with the words, in order. */
  attachments?: OutgoingAttachment[];
  state: OutgoingState;
  attempts: number;
  createdAt: string;
  message?: Message;
  error?: string;
  /** The API's code for a failure (for example UPLOAD_REJECTED), to explain it. */
  errorCode?: string;
}

export interface OutboxOptions {
  backoffMs?: (attempt: number) => number;
  /** Whether the device is online; while it is not, nothing is sent and nothing is spent. */
  online?: () => boolean;
}

const MAX_ATTEMPTS = 8;

/** RFC 9562 v4 UUID (crypto.randomUUID is missing on insecure origins). */
function uuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] as number) & 0x0f) | 0x40;
  b[8] = ((b[8] as number) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const browserOnline = () =>
  typeof navigator === 'undefined' || (navigator as { onLine?: boolean }).onLine !== false;

/**
 * Messages the visitor typed, in order, with honest states (W06): queued → sending → accepted,
 * or failed with retry, edit and remove. Unsent messages survive a page reload (W07). While the
 * device is offline they wait without spending attempts, and go out once it is back (W11); a retry
 * always reuses the client message id, so the server stores each message exactly once.
 */
export class Outbox {
  private items: OutgoingMessage[];
  private readonly listeners = new Set<(items: readonly OutgoingMessage[]) => void>();
  private running = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly backoffMs: (attempt: number) => number;
  private readonly online: () => boolean;
  private readonly onOnline = () => this.kick();

  constructor(
    private readonly client: HamnivoClient,
    readonly conversationId: string,
    options: OutboxOptions | ((attempt: number) => number) = {},
  ) {
    const opts = typeof options === 'function' ? { backoffMs: options } : options;
    this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(30_000, 500 * 2 ** attempt));
    this.online = opts.online ?? browserOnline;
    this.items = this.load();
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    if (this.items.some((i) => i.state === 'queued')) this.kick();
  }

  private get key() {
    return this.client.outboxKey(this.conversationId);
  }

  private load(): OutgoingMessage[] {
    try {
      const stored = JSON.parse(this.client.storage.getItem(this.key) ?? '[]') as OutgoingMessage[];
      // A send interrupted by a reload is simply retried with the same id.
      return stored.map((i) => (i.state === 'sending' ? { ...i, state: 'queued' } : i));
    } catch {
      return [];
    }
  }

  private save() {
    const pending = this.items.filter((i) => i.state !== 'accepted');
    try {
      if (pending.length) this.client.storage.setItem(this.key, JSON.stringify(pending));
      else this.client.storage.removeItem(this.key);
      this.client.trackOutbox(this.conversationId, pending.length > 0);
    } catch {
      // Storage full or blocked: the messages still go out from memory.
    }
    for (const listener of this.listeners) listener(this.items);
  }

  get messages(): readonly OutgoingMessage[] {
    return this.items;
  }

  subscribe(listener: (items: readonly OutgoingMessage[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.items);
    return () => this.listeners.delete(listener);
  }

  enqueue(text: string, attachments: readonly OutgoingAttachment[] = []): OutgoingMessage {
    const item: OutgoingMessage = {
      clientMessageId: uuid(),
      text,
      ...(attachments.length ? { attachments: [...attachments] } : {}),
      state: 'queued',
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.items = [...this.items, item];
    this.save();
    this.kick();
    return item;
  }

  /** Sends a failed message again (same id, so never twice). */
  retry(clientMessageId: string) {
    this.update(clientMessageId, { state: 'queued', attempts: 0 });
    this.kick();
  }

  /**
   * Takes back a message that is not on its way (failed, or waiting for the connection), for
   * example to edit it. Returns it, or null when it is being sent or already arrived.
   */
  remove(clientMessageId: string): OutgoingMessage | null {
    const item = this.items.find((i) => i.clientMessageId === clientMessageId);
    if (!item || (item.state !== 'failed' && item.state !== 'queued')) return null;
    this.items = this.items.filter((i) => i !== item);
    this.save();
    return item;
  }

  /** Drops accepted messages once they appear in the conversation stream. */
  settle(clientMessageId: string) {
    this.items = this.items.filter(
      (i) => !(i.clientMessageId === clientMessageId && i.state === 'accepted'),
    );
    this.save();
  }

  /** Tries the queue now (for example from a "try again" button). */
  flush() {
    this.kick();
  }

  private update(clientMessageId: string, patch: Partial<OutgoingMessage>) {
    this.items = this.items.map((i) =>
      i.clientMessageId === clientMessageId ? { ...i, ...patch } : i,
    );
    this.save();
  }

  private kick(delay = 0) {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.drain(), delay);
  }

  /** Sends queued messages one at a time, preserving their order. */
  async drain(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (;;) {
        // Offline: wait for the "online" event instead of spending attempts.
        if (!this.online()) return;
        const next = this.items.find((i) => i.state === 'queued');
        if (!next) return;
        this.update(next.clientMessageId, { state: 'sending', attempts: next.attempts + 1 });
        try {
          const result = await this.client.send(
            this.conversationId,
            next.clientMessageId,
            next.text,
            (next.attachments ?? []).map((a) => a.uploadId),
          );
          this.update(next.clientMessageId, { state: 'accepted', message: result.message });
        } catch (error) {
          const problem = error as HamnivoApiError;
          // The connection dropped while sending: wait for it, without counting the attempt.
          if (problem.status === 0 && !this.online()) {
            this.update(next.clientMessageId, { state: 'queued', attempts: next.attempts });
            return;
          }
          const attempts = next.attempts + 1;
          if (problem.retryable && attempts < MAX_ATTEMPTS) {
            this.update(next.clientMessageId, { state: 'queued', error: problem.message });
            this.kick(problem.retryAfterMs ?? this.backoffMs(attempts));
            return;
          }
          this.update(next.clientMessageId, {
            state: 'failed',
            error: problem.message,
            ...(problem.code ? { errorCode: problem.code } : {}),
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.listeners.clear();
  }
}
