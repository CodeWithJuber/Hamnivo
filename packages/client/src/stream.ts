import { type EventSourceMessage, EventSourceParserStream } from 'eventsource-parser/stream';
import type { HamnivoClient } from './client.js';
import { problemOf } from './errors.js';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface StreamControlFrame {
  control: 'heartbeat' | 'resync_required' | 'auth_expired';
  [key: string]: unknown;
}

export interface StreamHandlers {
  /** A journal event (message.created, conversation.updated, …) in sequence order. */
  onEvent(event: Record<string, unknown> & { sequence: number; type: string }): void;
  /** History must be reloaded (the cursor is older than the retained journal). */
  onResync?(): void;
  onStatus?(status: StreamStatus): void;
  /** A failure that stops the stream (for example the conversation is gone). */
  onError?(error: unknown): void;
}

export interface StreamOptions {
  /** Last sequence already shown; omitted means "from now on". */
  after?: number;
  /** Reconnect when nothing (not even a heartbeat) arrived for this long. */
  idleTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
}

/**
 * A resumable conversation stream (W07): Server-Sent Events over fetch, so the access token goes
 * in a header, never in the URL. It reconnects with backoff and `Last-Event-ID`, renews the
 * session on `auth_expired`, asks for a history reload on `resync_required` and drops duplicates.
 */
export class EventStream {
  private cursor: number | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private attempt = 0;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private status: StreamStatus = 'connecting';

  constructor(
    private readonly client: HamnivoClient,
    private readonly conversationId: string,
    private readonly handlers: StreamHandlers,
    private readonly options: StreamOptions = {},
  ) {
    this.cursor = options.after;
    void this.run();
  }

  get lastSequence(): number | undefined {
    return this.cursor;
  }

  private setStatus(status: StreamStatus) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.controller?.abort(), this.options.idleTimeoutMs ?? 45_000);
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      this.controller = new AbortController();
      let reason: 'ended' | 'auth' | 'resync' | 'fatal' = 'ended';
      try {
        const response = await this.client.openStream(
          `/v1/widget/conversations/${encodeURIComponent(this.conversationId)}/events`,
          {
            accept: 'text/event-stream',
            ...(this.cursor !== undefined ? { 'last-event-id': String(this.cursor) } : {}),
          },
          this.controller.signal,
        );
        if (!response.ok || !response.body) {
          const problem = await problemOf(response);
          if (!problem.retryable) {
            this.handlers.onError?.(problem);
            this.close();
            return;
          }
          throw problem;
        }
        this.setStatus('open');
        this.attempt = 0;
        this.armIdle();
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new EventSourceParserStream())
          .getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          this.armIdle();
          reason = this.handle(value) ?? reason;
          if (reason !== 'ended') {
            this.controller.abort();
            break;
          }
        }
      } catch (error) {
        if (this.closed) return;
        if ((error as { name?: string }).name !== 'AbortError') reason = 'ended';
      }
      if (this.closed) return;
      if (reason === 'resync') {
        this.cursor = undefined;
        this.handlers.onResync?.();
      }
      if (reason === 'auth') await this.client.renew().catch(() => undefined);
      this.setStatus('reconnecting');
      this.attempt += 1;
      const wait = reason === 'auth' ? 0 : (this.options.backoffMs ?? backoff)(this.attempt);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private handle(message: EventSourceMessage): 'auth' | 'resync' | undefined {
    if (message.event === 'control') {
      const frame = JSON.parse(message.data) as StreamControlFrame;
      if (frame.control === 'auth_expired') return 'auth';
      if (frame.control === 'resync_required') return 'resync';
      return undefined;
    }
    const event = JSON.parse(message.data) as Record<string, unknown> & {
      sequence: number;
      type: string;
    };
    const sequence = Number(event.sequence);
    if (this.cursor !== undefined && sequence <= this.cursor) return undefined;
    this.cursor = sequence;
    this.handlers.onEvent(event);
    return undefined;
  }

  close() {
    this.closed = true;
    if (this.idle) clearTimeout(this.idle);
    this.controller?.abort();
    this.setStatus('closed');
  }
}

/** Exponential backoff with full jitter: ~1 s, 2 s, 4 s … capped at 30 s. */
export function backoff(attempt: number): number {
  const cap = Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(cap / 2 + Math.random() * (cap / 2));
}
