import type { ActivityKind } from '@hamnivo/contracts';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../tokens.js';

/**
 * What an AI reply is doing while it is written, as the customer's streams hear of it: a step
 * started or finished (`activity`), or words of a draft (`message.delta`). Live only, like typing:
 * nothing is stored and nothing is replayed. A customer's Stop goes the other way, to the worker
 * writing the reply.
 */
export type RunSignal =
  | {
      type: 'activity';
      data: { runId: string; kind: ActivityKind; label: string; state: 'started' | 'finished' };
    }
  | {
      type: 'message.delta';
      data: { runId: string; draftId: string; index: number; textDelta: string };
    };

const signalChannel = (tenantId: string, conversationId: string) =>
  `hamnivo:run:${tenantId}:${conversationId}`;
const stopChannel = (tenantId: string, conversationId: string) =>
  `hamnivo:run-stop:${tenantId}:${conversationId}`;

const KINDS: ReadonlySet<string> = new Set(['run', 'searching', 'tool', 'writing', 'checking']);

/** A signal read back from Redis, checked field by field; null for anything else. */
export function parseRunSignal(message: string): RunSignal | null {
  let parsed: { type?: unknown; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  const data = parsed.data;
  if (!data || typeof data !== 'object' || typeof data.runId !== 'string') return null;
  if (
    parsed.type === 'activity' &&
    typeof data.kind === 'string' &&
    KINDS.has(data.kind) &&
    typeof data.label === 'string' &&
    (data.state === 'started' || data.state === 'finished')
  ) {
    return parsed as RunSignal;
  }
  if (
    parsed.type === 'message.delta' &&
    typeof data.draftId === 'string' &&
    Number.isInteger(data.index) &&
    (data.index as number) >= 0 &&
    typeof data.textDelta === 'string'
  ) {
    return parsed as RunSignal;
  }
  return null;
}

@Injectable()
export class RunSignals implements OnApplicationShutdown {
  private readonly logger = new Logger(RunSignals.name);
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<(message: string) => void>>();

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Tells the conversation's customer streams; a lost signal only means a less lively reply. */
  async publish(tenantId: string, conversationId: string, signal: RunSignal): Promise<void> {
    try {
      await this.redis.publish(signalChannel(tenantId, conversationId), JSON.stringify(signal));
    } catch (error) {
      this.logger.warn(`run signal failed: ${String(error)}`);
    }
  }

  /** The customer asked the reply being written to stop. */
  async stop(tenantId: string, conversationId: string, runId: string): Promise<void> {
    try {
      await this.redis.publish(stopChannel(tenantId, conversationId), runId);
    } catch (error) {
      this.logger.warn(`stop signal failed: ${String(error)}`);
    }
  }

  /** Calls `listener` for each signal of the conversation; returns an unsubscribe. */
  onSignal(
    tenantId: string,
    conversationId: string,
    listener: (signal: RunSignal) => void,
  ): Promise<() => void> {
    return this.listen(signalChannel(tenantId, conversationId), (message) => {
      const signal = parseRunSignal(message);
      if (signal) listener(signal);
    });
  }

  /** Calls `listener` with the run id when the customer asks a reply to stop. */
  onStop(
    tenantId: string,
    conversationId: string,
    listener: (runId: string) => void,
  ): Promise<() => void> {
    return this.listen(stopChannel(tenantId, conversationId), listener);
  }

  private async listen(channel: string, listener: (message: string) => void) {
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('error', () => undefined);
      this.subscriber.on('message', (name: string, message: string) => {
        for (const fn of this.listeners.get(name) ?? []) fn(message);
      });
    }
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async onApplicationShutdown(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }
}
