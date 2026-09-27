import { type Db, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JournalService } from '../authority/journal.service.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { WidgetClaims } from './tokens.service.js';

const PAGE = 100;

/**
 * Customer event streams (W07): Server-Sent Events replaying the customer lane of the journal from
 * a cursor (`Last-Event-ID`), then live. Heartbeats keep proxies open and re-check the session, so
 * sign-out, identity switch and token expiry end the stream with `auth_expired`.
 */
@Injectable()
export class WidgetEventsService {
  private readonly logger = new Logger(WidgetEventsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly journal: JournalService,
  ) {}

  private async sessionActive(claims: WidgetClaims): Promise<boolean> {
    if (claims.expiresAt <= this.clock()) return false;
    const [session] = await withTenant(this.db, { tenantId: claims.tenantId }, (tx) =>
      tx
        .select({ revokedAt: schema.widgetSessions.revokedAt })
        .from(schema.widgetSessions)
        .where(eq(schema.widgetSessions.id, claims.sessionId)),
    );
    return Boolean(session && !session.revokedAt);
  }

  async stream(
    request: FastifyRequest,
    reply: FastifyReply,
    claims: WidgetClaims,
    conversationId: string,
    after: number,
  ): Promise<void> {
    const tenantId = claims.tenantId;
    let cursor = after;
    let closed = false;
    let flushing = false;
    let again = false;
    const headers: Record<string, string | number | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) headers[name] = value as string | number | string[];
    }
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...headers,
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-request-id': String(request.id),
    });
    raw.write(`retry: 3000\n: stream open\n\n`);

    const write = (chunk: string) => {
      if (!closed) raw.write(chunk);
    };
    const control = (frame: Record<string, unknown>) =>
      write(`event: control\ndata: ${JSON.stringify(frame)}\n\n`);
    let unsubscribe: () => void = () => undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const end = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      raw.end();
    };
    const flush = async (): Promise<void> => {
      if (flushing) {
        again = true;
        return;
      }
      flushing = true;
      try {
        do {
          again = false;
          for (;;) {
            if (closed) return;
            const page = await this.journal.read(
              tenantId,
              conversationId,
              'customer',
              cursor,
              PAGE,
            );
            if (page.resyncRequired) {
              control({ control: 'resync_required', reason: 'cursor_expired' });
              end();
              return;
            }
            for (const event of page.events) {
              const sequence = Number(event.sequence);
              write(
                `id: ${sequence}\nevent: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
              );
              cursor = sequence;
            }
            if (page.events.length < PAGE) break;
          }
        } while (again && !closed);
      } catch (error) {
        this.logger.warn(`stream flush failed: ${String(error)}`);
      } finally {
        flushing = false;
      }
    };

    request.raw.on('close', end);
    unsubscribe = await this.journal.subscribe(tenantId, conversationId, () => void flush());
    heartbeat = setInterval(() => {
      void (async () => {
        if (!(await this.sessionActive(claims).catch(() => true))) {
          control({ control: 'auth_expired' });
          end();
          return;
        }
        control({ control: 'heartbeat', at: this.clock().toISOString() });
        // A lost pub/sub signal only delays delivery until the next heartbeat.
        await flush();
      })();
    }, this.config.STREAM_HEARTBEAT_SECONDS * 1000);
    await flush();
  }

  /** Long-poll fallback: events after the cursor, waiting up to `waitSeconds` for new ones. */
  async poll(claims: WidgetClaims, conversationId: string, after: number, waitSeconds: number) {
    const read = () => this.journal.read(claims.tenantId, conversationId, 'customer', after, PAGE);
    let page = await read();
    if (page.events.length === 0 && !page.resyncRequired && waitSeconds > 0) {
      await new Promise<void>((resolve) => {
        let unsubscribe: () => void = () => undefined;
        const timer = setTimeout(() => {
          unsubscribe();
          resolve();
        }, waitSeconds * 1000);
        void this.journal
          .subscribe(claims.tenantId, conversationId, () => {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          })
          .then((fn) => {
            unsubscribe = fn;
          });
      });
      page = await read();
    }
    return {
      events: page.events,
      control: page.resyncRequired
        ? { control: 'resync_required' as const, reason: 'cursor_expired' as const }
        : null,
    };
  }
}
