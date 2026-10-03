import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CreatedOperatorApiKey, OperatorApiKey } from '@hamnivo/contracts';
import {
  appendPlatformAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  toPublicId,
} from '@hamnivo/db';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import type { OperatorContext } from '../identity/request-auth.js';
import type { KeyRing } from '../secrets/envelope.js';
import { CLOCK, type Clock, CONFIG, PLATFORM_DB } from '../tokens.js';

/**
 * Operator API keys look like `hvop_8f3k2m1qa9bc_<43 characters>`: the first part is the public
 * prefix (stored, shown, used to find the key), the rest the secret, shown once. Only an HMAC of
 * the secret is stored, keyed with a key derived from the key-encryption key, so a copy of the
 * database alone cannot check guesses. A key acts on the whole server (it creates, suspends and
 * re-plans workspaces), so it lives with the platform operator, never inside a workspace.
 */

const PREFIX = 'hvop_';
const KEY = /^(hvop_[0-9a-hjkmnp-tv-z]{12})_([0-9A-Za-z]{40,64})$/;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const INFO = 'hamnivo:operator-key:v1';

function encode(bytes: Buffer, alphabet: string, length: number): string {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  const base = BigInt(alphabet.length);
  let out = '';
  while (out.length < length) {
    out = alphabet[Number(value % base)] + out;
    value /= base;
  }
  return out;
}

export function generateOperatorKey(): { prefix: string; secret: string; key: string } {
  const prefix = `${PREFIX}${encode(randomBytes(8), CROCKFORD, 12)}`;
  const secret = encode(randomBytes(32), BASE62, 43);
  return { prefix, secret, key: `${prefix}_${secret}` };
}

export function parseOperatorKey(value: string): { prefix: string; secret: string } | null {
  const match = KEY.exec(value.trim());
  return match?.[1] && match[2] ? { prefix: match[1], secret: match[2] } : null;
}

export function bearerOperatorKey(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  return /^Bearer\s+(hvop_\S+)$/i.exec(value ?? '')?.[1] ?? null;
}

/** HMAC keys per key-encryption-key version, so stored hashes survive KEK rotation. */
export class OperatorKeyHasher {
  private readonly keys: Map<number, Buffer>;
  readonly version: number;

  constructor(ring: KeyRing) {
    this.version = ring.version;
    this.keys = new Map(
      [...ring.retired, [ring.version, ring.key] as const].map(([version, kek]) => [
        version,
        Buffer.from(hkdfSync('sha256', kek, Buffer.from('hamnivo'), Buffer.from(INFO), 32)),
      ]),
    );
  }

  hash(secret: string, version = this.version): Buffer {
    const key = this.keys.get(version);
    if (!key) throw new Error(`Key-encryption key version ${version} is not available`);
    return createHmac('sha256', key).update(secret, 'utf8').digest();
  }

  verify(secret: string, stored: Buffer, version: number): boolean {
    if (!this.keys.has(version)) return false;
    const computed = this.hash(secret, version);
    return computed.length === stored.length && timingSafeEqual(computed, stored);
  }
}

type KeyRow = typeof schema.operatorApiKeys.$inferSelect;

function keyView(row: KeyRow): z.infer<typeof OperatorApiKey> {
  return {
    id: toPublicId('operatorKey', row.id),
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** The key behind an operator API request. */
export interface OperatorKeyActor {
  keyId: string;
  name: string;
  /** How the key appears in audit logs: `operator-key:<name>`. */
  actor: string;
}

/** Operator API keys: created, listed and revoked in the platform console; checked per request. */
@Injectable()
export class OperatorKeysService {
  private readonly hasher: OperatorKeyHasher;

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Db | null,
    @Inject(CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.hasher = new OperatorKeyHasher(config.kek);
  }

  private get platform(): Db {
    if (!this.db) throw new AppError('NOT_FOUND');
    return this.db;
  }

  async list(): Promise<z.infer<typeof OperatorApiKey>[]> {
    const rows = await this.platform
      .select()
      .from(schema.operatorApiKeys)
      .orderBy(desc(schema.operatorApiKeys.createdAt));
    return rows.map(keyView);
  }

  async create(
    operator: OperatorContext,
    name: string,
  ): Promise<z.infer<typeof CreatedOperatorApiKey>> {
    const generated = generateOperatorKey();
    return this.platform.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.operatorApiKeys)
        .values({
          name,
          prefix: generated.prefix,
          secretHash: this.hasher.hash(generated.secret),
          hashVersion: this.hasher.version,
          createdBy: operator.principal.operatorId,
        })
        .returning();
      if (!row) throw new Error('operator key not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'operator_key.created',
        targetType: 'operator_key',
        targetId: toPublicId('operatorKey', row.id),
        outcome: 'success',
        data: { name, prefix: row.prefix },
      });
      return { ...keyView(row), key: generated.key };
    });
  }

  async revoke(
    operator: OperatorContext,
    publicId: string,
  ): Promise<z.infer<typeof OperatorApiKey>> {
    let id: string;
    try {
      id = fromPublicId('operatorKey', publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
    return this.platform.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.operatorApiKeys)
        .where(eq(schema.operatorApiKeys.id, id))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND');
      if (current.revokedAt) return keyView(current);
      const [row] = await tx
        .update(schema.operatorApiKeys)
        .set({ revokedAt: this.clock(), revokedBy: operator.principal.operatorId })
        .where(eq(schema.operatorApiKeys.id, id))
        .returning();
      if (!row) throw new Error('operator key not returned');
      await appendPlatformAudit(tx, {
        operatorId: operator.principal.operatorId,
        action: 'operator_key.revoked',
        targetType: 'operator_key',
        targetId: publicId,
        outcome: 'success',
        data: { name: row.name, prefix: row.prefix },
      });
      return keyView(row);
    });
  }

  /** Checks a presented key; every failure reads the same, so keys cannot be probed. */
  async authenticate(presented: string): Promise<OperatorKeyActor> {
    const parsed = parseOperatorKey(presented);
    const refuse = () =>
      new AppError('AUTH_REQUIRED', { detail: 'The operator API key is not valid.' });
    if (!parsed || !this.db) throw refuse();
    const [row] = await this.db
      .select()
      .from(schema.operatorApiKeys)
      .where(eq(schema.operatorApiKeys.prefix, parsed.prefix));
    if (
      !row ||
      row.revokedAt ||
      !this.hasher.verify(parsed.secret, row.secretHash, row.hashVersion)
    ) {
      throw refuse();
    }
    // "Last used", written at most once a minute.
    await this.db
      .update(schema.operatorApiKeys)
      .set({ lastUsedAt: this.clock() })
      .where(
        sql`${schema.operatorApiKeys.id} = ${row.id} and (${schema.operatorApiKeys.lastUsedAt} is null or ${schema.operatorApiKeys.lastUsedAt} < now() - interval '1 minute') and ${isNull(schema.operatorApiKeys.revokedAt)}`,
      );
    return { keyId: row.id, name: row.name, actor: `operator-key:${row.name}` };
  }
}

export const OPERATOR_API_ROUTE = 'hamnivo:operator-api-route';

/** Marks a route of the operator API: an operator API key, never a session. */
export const OperatorApiRoute = () => SetMetadata(OPERATOR_API_ROUTE, true);

declare module 'fastify' {
  interface FastifyRequest {
    hamnivoOperatorKey?: OperatorKeyActor;
  }
}

export const CurrentOperatorKey = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const key = ctx.switchToHttp().getRequest<FastifyRequest>().hamnivoOperatorKey;
  if (!key) throw new Error('CurrentOperatorKey used on a route without @OperatorApiRoute');
  return key;
});

/** Checks the operator API key of routes marked with @OperatorApiRoute(). */
@Injectable()
export class OperatorKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly keys: OperatorKeysService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const marked = this.reflector.getAllAndOverride<boolean | undefined>(OPERATOR_API_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!marked) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const presented = bearerOperatorKey(request.headers.authorization);
    if (!presented) {
      throw new AppError('AUTH_REQUIRED', {
        detail: 'Send an operator API key: Authorization: Bearer hvop_…',
      });
    }
    request.hamnivoOperatorKey = await this.keys.authenticate(presented);
    return true;
  }
}
