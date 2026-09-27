import { createHash } from 'node:crypto';
import { type Db, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import canonicalize from 'canonicalize';
import { and, eq, sql } from 'drizzle-orm';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { AppError } from './app-error.js';

const KEY = /^[\x21-\x7e]{1,255}$/;
const RETENTION_MS = 24 * 60 * 60 * 1000;
/** An in-progress record older than this is treated as abandoned (process died mid-request). */
const ABANDONED_MS = 60 * 1000;

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

export function validIdempotencyKey(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  if (!KEY.test(value)) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'Idempotency-Key', message: 'Use 1–255 visible ASCII characters' }],
    });
  }
  return value;
}

/**
 * `Idempotency-Key` handling (D01): the first request runs; a retry with the same key and body
 * replays the stored response; the same key with a different body is IDEMPOTENCY_CONFLICT.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run<T>(
    context: {
      tenantId: string;
      actor: string;
      route: string;
      key: string | undefined;
      body: unknown;
    },
    handler: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    if (!context.key) return { ...(await handler()), replayed: false };
    const scope = `${context.actor}:${context.route}`;
    const requestHash = createHash('sha256')
      .update(canonicalize(context.body ?? null) ?? '')
      .digest();
    const now = this.clock();
    const tenant = { tenantId: context.tenantId };

    const claimed = await withTenant(this.db, tenant, async (tx) => {
      const inserted = await tx
        .insert(schema.idempotencyKeys)
        .values({
          tenantId: context.tenantId,
          scope,
          key: context.key as string,
          requestHash,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        })
        .onConflictDoNothing()
        .returning({ key: schema.idempotencyKeys.key });
      if (inserted.length > 0) return { kind: 'run' as const };

      const [existing] = await tx
        .select()
        .from(schema.idempotencyKeys)
        .where(
          and(
            eq(schema.idempotencyKeys.scope, scope),
            eq(schema.idempotencyKeys.key, context.key as string),
          ),
        )
        .for('update');
      if (!existing) return { kind: 'run' as const };
      if (!existing.requestHash.equals(requestHash)) {
        throw new AppError('IDEMPOTENCY_CONFLICT');
      }
      if (existing.status === 'completed') {
        return {
          kind: 'replay' as const,
          status: existing.responseStatus ?? 200,
          body: existing.responseBody as T,
        };
      }
      if (now.getTime() - existing.createdAt.getTime() < ABANDONED_MS) {
        throw new AppError('IDEMPOTENCY_CONFLICT', {
          detail: 'The first request with this key is still being processed.',
          retryable: true,
          retryAfter: 2,
        });
      }
      await tx
        .update(schema.idempotencyKeys)
        .set({ createdAt: now })
        .where(
          and(
            eq(schema.idempotencyKeys.scope, scope),
            eq(schema.idempotencyKeys.key, context.key as string),
          ),
        );
      return { kind: 'run' as const };
    });

    if (claimed.kind === 'replay')
      return { status: claimed.status, body: claimed.body, replayed: true };

    try {
      const result = await handler();
      await withTenant(this.db, tenant, (tx) =>
        tx
          .update(schema.idempotencyKeys)
          .set({
            status: 'completed',
            responseStatus: result.status,
            responseBody: result.body as object,
          })
          .where(
            and(
              eq(schema.idempotencyKeys.scope, scope),
              eq(schema.idempotencyKeys.key, context.key as string),
            ),
          ),
      );
      return { ...result, replayed: false };
    } catch (error) {
      // Let the client retry after a failure: forget the in-progress record.
      await withTenant(this.db, tenant, (tx) =>
        tx
          .delete(schema.idempotencyKeys)
          .where(
            and(
              eq(schema.idempotencyKeys.scope, scope),
              eq(schema.idempotencyKeys.key, context.key as string),
              sql`${schema.idempotencyKeys.status} = 'in_progress'`,
            ),
          ),
      ).catch(() => undefined);
      throw error;
    }
  }
}
