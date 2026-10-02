import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { newId } from './ids.js';
import { AUDIT_ACTOR_TYPES, AUDIT_OUTCOMES, auditEvents, auditHeads } from './schema/audit.js';
import { platformAuditEvents, platformAuditHead } from './schema/operators.js';
import type { TenantTx } from './tenant.js';

/** Hash that precedes each tenant's first audit event. */
export const AUDIT_GENESIS: Buffer = Buffer.alloc(32);

export interface AuditInput {
  actorType: (typeof AUDIT_ACTOR_TYPES)[number];
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: (typeof AUDIT_OUTCOMES)[number];
  reason?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface AppendedAudit {
  id: string;
  seq: number;
  hash: Buffer;
}

interface ChainRecord {
  v: 1;
  tenantId: string;
  seq: number;
  id: string;
  occurredAt: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  data: Record<string, unknown>;
}

/** Keys that name credentials. Their values never reach an audit log, whoever passes them. */
const CREDENTIAL_KEY =
  /^(?:passphrase|authorization|cookie|plaintext|otp|totp|token|api_?key|private_?key|access_?token|refresh_?token|id_?token|backup_?codes?)$|(?:secret|password)$/i;

export const AUDIT_REDACTED = '[redacted]';

/**
 * Replaces the value of every credential-like key, at any depth, with `[redacted]` (A09: audit
 * data never holds secrets). Callers record identifiers and counts, never values; this is the
 * backstop for a mistake.
 */
export function redactAuditData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditData);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        CREDENTIAL_KEY.test(key) ? AUDIT_REDACTED : redactAuditData(entry),
      ]),
    );
  }
  return value;
}

/** sha256(previous hash ‖ RFC 8785 canonical JSON of the event). */
export function auditHash(prevHash: Buffer, record: ChainRecord | PlatformChainRecord): Buffer {
  const canonical = canonicalize(record);
  if (canonical === undefined) throw new TypeError('audit record is not serializable');
  return createHash('sha256').update(prevHash).update(canonical, 'utf8').digest();
}

/**
 * Appends one event to the tenant's hash-chained audit log. Must run inside withTenant(); the
 * tenant's chain head is row-locked until the transaction ends, so appends are serialized per
 * tenant and the event commits or rolls back together with the change it records.
 */
export async function appendAudit(tx: TenantTx, input: AuditInput): Promise<AppendedAudit> {
  const head = await tx.execute<{ tenant_id: string; last_seq: string; last_hash: Buffer }>(sql`
    insert into audit_heads (tenant_id, last_seq, last_hash)
    values ((select app.current_tenant()), 0, ${AUDIT_GENESIS})
    on conflict (tenant_id) do update set updated_at = now()
    returning tenant_id, last_seq, last_hash`);
  const row = head.rows[0];
  if (!row) throw new Error('audit head was not returned');

  const seq = Number(row.last_seq) + 1;
  const id = newId();
  const occurredAt = input.occurredAt ?? new Date();
  const record: ChainRecord = {
    v: 1,
    tenantId: row.tenant_id,
    seq,
    id,
    occurredAt: occurredAt.toISOString(),
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    requestId: input.requestId ?? null,
    data: redactAuditData(input.data ?? {}) as Record<string, unknown>,
  };
  const hash = auditHash(row.last_hash, record);

  await tx.insert(auditEvents).values({
    tenantId: row.tenant_id,
    seq,
    id,
    occurredAt,
    actorType: input.actorType,
    actorId: record.actorId,
    action: input.action,
    targetType: record.targetType,
    targetId: record.targetId,
    outcome: input.outcome,
    reason: record.reason,
    requestId: record.requestId,
    data: record.data,
    prevHash: row.last_hash,
    hash,
  });
  await tx
    .update(auditHeads)
    .set({ lastSeq: seq, lastHash: hash })
    .where(eq(auditHeads.tenantId, row.tenant_id));
  return { id, seq, hash };
}

export type AuditVerification =
  | { ok: true; checked: number; lastSeq: number }
  | {
      ok: false;
      seq: number;
      reason: 'gap' | 'prev_hash_mismatch' | 'hash_mismatch' | 'head_mismatch';
    };

/**
 * Recomputes the tenant's hash chain (inside withTenant()). A range that starts after 1 trusts
 * the first event's stored prev_hash as its anchor.
 */
export async function verifyAuditChain(
  tx: TenantTx,
  range: { fromSeq?: number; toSeq?: number; batchSize?: number } = {},
): Promise<AuditVerification> {
  const batchSize = range.batchSize ?? 1000;
  let nextSeq = range.fromSeq ?? 1;
  let prev: Buffer | null = nextSeq === 1 ? AUDIT_GENESIS : null;
  let checked = 0;
  let lastSeq = nextSeq - 1;

  for (;;) {
    const conditions = [gte(auditEvents.seq, nextSeq)];
    if (range.toSeq !== undefined) conditions.push(lte(auditEvents.seq, range.toSeq));
    const rows = await tx
      .select()
      .from(auditEvents)
      .where(and(...conditions))
      .orderBy(asc(auditEvents.seq))
      .limit(batchSize);
    for (const event of rows) {
      if (event.seq !== nextSeq) return { ok: false, seq: nextSeq, reason: 'gap' };
      if (prev && !prev.equals(event.prevHash)) {
        return { ok: false, seq: event.seq, reason: 'prev_hash_mismatch' };
      }
      const expected = auditHash(event.prevHash, {
        v: 1,
        tenantId: event.tenantId,
        seq: event.seq,
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        actorType: event.actorType,
        actorId: event.actorId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        outcome: event.outcome,
        reason: event.reason,
        requestId: event.requestId,
        data: event.data,
      });
      if (!expected.equals(event.hash))
        return { ok: false, seq: event.seq, reason: 'hash_mismatch' };
      prev = event.hash;
      lastSeq = event.seq;
      nextSeq += 1;
      checked += 1;
    }
    if (rows.length < batchSize) break;
  }

  if (range.toSeq === undefined) {
    const [head] = await tx.select().from(auditHeads).limit(1);
    const headSeq = head?.lastSeq ?? 0;
    if (headSeq !== lastSeq || (head && prev && !head.lastHash.equals(prev))) {
      return { ok: false, seq: headSeq, reason: 'head_mismatch' };
    }
  }
  return { ok: true, checked, lastSeq };
}

// ── Platform audit (A17, A18) ───────────────────────────────────────────────────────────────

interface PlatformChainRecord {
  v: 1;
  chain: 'platform';
  seq: number;
  id: string;
  occurredAt: string;
  operatorId: string | null;
  action: string;
  tenantId: string | null;
  targetType: string | null;
  targetId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  data: Record<string, unknown>;
}

export interface PlatformAuditInput {
  /** platform_operators.id, or null for the platform itself. */
  operatorId: string | null;
  action: string;
  tenantId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  outcome: (typeof AUDIT_OUTCOMES)[number];
  reason?: string | null;
  requestId?: string | null;
  data?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Appends one event to the platform audit chain, in a transaction of the platform role. The chain
 * head is row-locked until the transaction ends, so appends are serialized, as for tenants.
 */
export async function appendPlatformAudit(
  tx: TenantTx,
  input: PlatformAuditInput,
): Promise<AppendedAudit> {
  const head = await tx.execute<{ last_seq: string; last_hash: Buffer }>(sql`
    insert into platform_audit_head (id, last_seq, last_hash)
    values (1, 0, ${AUDIT_GENESIS})
    on conflict (id) do update set updated_at = now()
    returning last_seq, last_hash`);
  const row = head.rows[0];
  if (!row) throw new Error('platform audit head was not returned');
  const seq = Number(row.last_seq) + 1;
  const id = newId();
  const occurredAt = input.occurredAt ?? new Date();
  const record: PlatformChainRecord = {
    v: 1,
    chain: 'platform',
    seq,
    id,
    occurredAt: occurredAt.toISOString(),
    operatorId: input.operatorId,
    action: input.action,
    tenantId: input.tenantId ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    requestId: input.requestId ?? null,
    data: redactAuditData(input.data ?? {}) as Record<string, unknown>,
  };
  const hash = auditHash(row.last_hash, record);
  await tx.insert(platformAuditEvents).values({
    seq,
    id,
    occurredAt,
    operatorId: record.operatorId,
    action: record.action,
    tenantId: record.tenantId,
    targetType: record.targetType,
    targetId: record.targetId,
    outcome: input.outcome,
    reason: record.reason,
    requestId: record.requestId,
    data: record.data,
    prevHash: row.last_hash,
    hash,
  });
  await tx
    .update(platformAuditHead)
    .set({ lastSeq: seq, lastHash: hash })
    .where(eq(platformAuditHead.id, 1));
  return { id, seq, hash };
}

/** Recomputes the whole platform audit chain (platform role). */
export async function verifyPlatformAuditChain(
  tx: TenantTx,
  batchSize = 1000,
): Promise<AuditVerification> {
  let nextSeq = 1;
  let prev = AUDIT_GENESIS;
  let checked = 0;
  for (;;) {
    const rows = await tx
      .select()
      .from(platformAuditEvents)
      .where(gte(platformAuditEvents.seq, nextSeq))
      .orderBy(asc(platformAuditEvents.seq))
      .limit(batchSize);
    for (const event of rows) {
      if (event.seq !== nextSeq) return { ok: false, seq: nextSeq, reason: 'gap' };
      if (!prev.equals(event.prevHash)) {
        return { ok: false, seq: event.seq, reason: 'prev_hash_mismatch' };
      }
      const expected = auditHash(event.prevHash, {
        v: 1,
        chain: 'platform',
        seq: event.seq,
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        operatorId: event.operatorId,
        action: event.action,
        tenantId: event.tenantId,
        targetType: event.targetType,
        targetId: event.targetId,
        outcome: event.outcome,
        reason: event.reason,
        requestId: event.requestId,
        data: event.data,
      });
      if (!expected.equals(event.hash)) {
        return { ok: false, seq: event.seq, reason: 'hash_mismatch' };
      }
      prev = event.hash;
      nextSeq += 1;
      checked += 1;
    }
    if (rows.length < batchSize) break;
  }
  const [head] = await tx.select().from(platformAuditHead).limit(1);
  const lastSeq = nextSeq - 1;
  if ((head?.lastSeq ?? 0) !== lastSeq || (head && !head.lastHash.equals(prev))) {
    return { ok: false, seq: head?.lastSeq ?? 0, reason: 'head_mismatch' };
  }
  return { ok: true, checked, lastSeq };
}
