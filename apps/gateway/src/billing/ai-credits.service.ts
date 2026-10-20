import { randomUUID } from 'node:crypto';
import { type Db, fromPublicId, newId, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { parseLimits, periodOf } from '@hamnivo/domain/billing';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import { planLimitError } from '../common/plan-limit.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';

export type AiSource = 'managed' | 'byok';
export interface AiAttemptSpec {
  tenantId: string;
  key: string;
  provider: string;
  modelId: string;
  source: AiSource;
  connectionId?: string;
  /** A conservative upper bound while the provider call is in flight. */
  reserveTokens: number;
  timeoutMs: number;
  /** Optional operational IDs; funding is resolved independently by the server. */
  attribution?: Record<string, string>;
}
export interface AiReservation {
  id: string;
  tenantId: string;
  leaseToken: string;
  source: AiSource;
}
export interface AiMeasuredUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

function tokens(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Provider SDKs sometimes attach usage to an exception after a partial response. */
export function measuredUsage(value: unknown): AiMeasuredUsage {
  const seen = new Set<unknown>();
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let partial: AiMeasuredUsage = { inputTokens: null, outputTokens: null };
  const total = (v: unknown) =>
    tokens(v && typeof v === 'object' ? (v as { total?: unknown }).total : v);
  for (let count = 0; queue.length && count < 32; count += 1) {
    const next = queue.shift();
    if (
      !next ||
      next.depth > 6 ||
      !next.value ||
      typeof next.value !== 'object' ||
      seen.has(next.value)
    )
      continue;
    seen.add(next.value);
    const record = next.value as Record<string, unknown>;
    const inputTokens = total(
      record.inputTokens ?? record.promptTokens ?? record.input_tokens ?? record.prompt_tokens,
    );
    const outputTokens = total(
      record.outputTokens ??
        record.completionTokens ??
        record.output_tokens ??
        record.completion_tokens,
    );
    if (inputTokens !== null && outputTokens !== null) return { inputTokens, outputTokens };
    if (
      partial.inputTokens === null &&
      partial.outputTokens === null &&
      (inputTokens !== null || outputTokens !== null)
    )
      partial = { inputTokens, outputTokens };
    for (const key of ['totalUsage', 'usage', 'response', 'data', 'cause', 'error']) {
      if (record[key]) queue.push({ value: record[key], depth: next.depth + 1 });
    }
  }
  return partial;
}

/** Reserve input bytes plus the maximum generated tokens for every possible model step. */
export function reservationSize(
  system: string,
  messages: unknown,
  maxOutput: number,
  steps: number,
): number {
  const count = Math.max(1, Math.min(steps, 100));
  const promptBytes = Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(messages));
  return Math.min(Number.MAX_SAFE_INTEGER, (promptBytes + maxOutput + 256) * count);
}

@Injectable()
export class AiCreditsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'ai-credits' }, work);
  }

  /** The tenant row is the serialization point, including when it has no entitlement row. */
  private async lock(tx: TenantTx, tenantId: string): Promise<void> {
    const { rows } = await tx.execute(
      sql`select id from tenants where id = ${tenantId}::uuid for update`,
    );
    if (!rows.length) throw new AppError('NOT_FOUND', { detail: 'Workspace not found.' });
  }

  async reserve(spec: AiAttemptSpec): Promise<AiReservation> {
    if (!spec.key || !Number.isSafeInteger(spec.reserveTokens) || spec.reserveTokens < 0) {
      throw new Error('Invalid AI reservation');
    }
    const now = this.clock();
    const period = periodOf(now);
    const leaseToken = randomUUID();
    const id = newId();
    return this.tx(spec.tenantId, async (tx) => {
      const payer = await tx.execute<{ payer: string }>(sql`select app.lock_ai_payer() as payer`);
      const payerTenantId = payer.rows[0]?.payer;
      if (!payerTenantId) throw new AppError('NOT_FOUND', { detail: 'AI payer not found.' });
      await this.lock(tx, spec.tenantId);
      await tx.execute(sql`update ai_credit_attempts set status = 'expired'
        where tenant_id = ${spec.tenantId}::uuid and status = 'reserved' and expires_at <= ${now}`);
      const existing = await tx.execute(sql`select status from ai_credit_attempts
        where tenant_id = ${spec.tenantId}::uuid and attempt_key = ${spec.key}`);
      if (existing.rows.length) {
        throw new AppError('IDEMPOTENCY_CONFLICT', {
          detail: 'This AI attempt has already been started.',
        });
      }
      let rate: { id: string; version: number } | null = null;
      if (spec.source === 'managed') {
        const entitlement = await tx.execute<{
          limits: unknown;
          budget: string | null;
          plan_key: string | null;
        }>(
          sql`select limits, ai_token_budget as budget, plan_key from tenant_entitlements
              where tenant_id = ${spec.tenantId}::uuid`,
        );
        const row = entitlement.rows[0];
        const limit = row?.plan_key ? parseLimits(row.limits).aiTokens : null;
        const budget =
          row?.budget === null || row?.budget === undefined ? null : Number(row.budget);
        const usedResult = await tx.execute<{ used: string }>(sql`
          select coalesce(sum(quantity), 0)::text as used from usage_entries
          where tenant_id = ${spec.tenantId}::uuid and meter in ('ai.tokens.input', 'ai.tokens.output')
          and occurred_at >= ${period.start} and occurred_at < ${period.end}`);
        const heldResult = await tx.execute<{ held: string }>(sql`
          select coalesce(sum(reserved_tokens), 0)::text as held from ai_credit_attempts
          where tenant_id = ${spec.tenantId}::uuid and source = 'managed' and status in ('reserved', 'expired')
          and period_key = ${period.key}`);
        const used = Number(usedResult.rows[0]?.used ?? 0) + Number(heldResult.rows[0]?.held ?? 0);
        if (limit !== null && used + spec.reserveTokens > limit) {
          throw planLimitError('aiTokens', { max: limit, used, resetsAt: period.end });
        }
        if (budget !== null && used + spec.reserveTokens > budget) {
          throw new AppError('QUOTA_EXCEEDED', {
            detail: 'The workspace’s AI budget for this period is used up.',
            quota: {
              scope: 'budget',
              limit: 'aiTokens',
              max: budget,
              used,
              resetsAt: period.end.toISOString(),
            },
          });
        }
        const payerCheck = await tx.execute<{ allowed: boolean }>(
          sql`select app.ai_payer_allows(${spec.reserveTokens}::bigint, ${period.start}::timestamptz, ${period.end}::timestamptz, ${period.key}) as allowed`,
        );
        if (!payerCheck.rows[0]?.allowed)
          throw new AppError('QUOTA_EXCEEDED', {
            detail: 'The AI payer’s available token allowance is insufficient.',
          });
        const rates = await tx.execute<{ id: string; version: number }>(sql`
          select id, version from ai_credit_rates where active
          and (provider = ${spec.provider} or provider = '*')
          and (model_id = ${spec.modelId} or model_id = '*')
          order by (provider = ${spec.provider}) desc, (model_id = ${spec.modelId}) desc, version desc limit 1`);
        rate = rates.rows[0] ?? null;
        if (!rate)
          throw new AppError('VALIDATION_FAILED', {
            detail: 'No managed AI credit rate is configured.',
          });
      }
      const expiresAt = new Date(now.getTime() + Math.max(60_000, spec.timeoutMs + 60_000));
      await tx.execute(sql`insert into ai_credit_attempts
        (id, tenant_id, payer_tenant_id, attempt_key, source, status, provider, model_id, connection_id, period_key,
         rate_id, rate_version, reserved_tokens, attribution, lease_token, expires_at)
        values (${id}::uuid, ${spec.tenantId}::uuid, ${payerTenantId}::uuid, ${spec.key}, ${spec.source}, 'reserved',
          ${spec.provider}, ${spec.modelId}, ${spec.connectionId ? fromPublicId('modelConnection', spec.connectionId) : null}::uuid,
          ${period.key}, ${rate?.id ?? null}::uuid, ${rate?.version ?? null},
          ${spec.source === 'managed' ? spec.reserveTokens : 0},
          ${JSON.stringify(spec.attribution ?? {})}::jsonb, ${leaseToken}::uuid, ${expiresAt})`);
      return { id, tenantId: spec.tenantId, leaseToken, source: spec.source };
    });
  }

  /** A late receipt is still recorded after lease expiry; idempotency prevents a second charge. */
  async settle(reservation: AiReservation, usage: AiMeasuredUsage): Promise<void> {
    const input = tokens(usage.inputTokens);
    const output = tokens(usage.outputTokens);
    await this.tx(reservation.tenantId, async (tx) => {
      await tx.execute(sql`select app.lock_ai_payer()`);
      await this.lock(tx, reservation.tenantId);
      const found = await tx.execute<{
        status: string;
        source: AiSource;
        rate_id: string | null;
        period_key: string;
        reserved_tokens: string;
        input_tokens: string | null;
        output_tokens: string | null;
        attribution: Record<string, unknown>;
        attempt_key: string;
        input_milli_credits: number | null;
        output_milli_credits: number | null;
      }>(sql`select a.status, a.source, a.rate_id, a.period_key, a.attempt_key, a.attribution, a.reserved_tokens, a.input_tokens, a.output_tokens,
          r.input_milli_credits, r.output_milli_credits
        from ai_credit_attempts a left join ai_credit_rates r on r.id = a.rate_id
        where a.tenant_id = ${reservation.tenantId}::uuid and a.id = ${reservation.id}::uuid
        and a.lease_token = ${reservation.leaseToken}::uuid for update of a`);
      const row = found.rows[0];
      if (!row)
        throw new AppError('IDEMPOTENCY_CONFLICT', { detail: 'AI reservation lease is invalid.' });
      if (row.status === 'settled') return;
      if (row.status === 'released')
        throw new AppError('IDEMPOTENCY_CONFLICT', { detail: 'AI reservation was released.' });
      const measuredInput = input ?? (row.input_tokens === null ? null : Number(row.input_tokens));
      const measuredOutput =
        output ?? (row.output_tokens === null ? null : Number(row.output_tokens));
      const complete = measuredInput !== null && measuredOutput !== null;
      const creditsMilli =
        row.source === 'managed'
          ? (measuredInput ?? 0) * (row.input_milli_credits ?? 0) +
            (measuredOutput ?? 0) * (row.output_milli_credits ?? 0)
          : 0;
      if (!Number.isSafeInteger(creditsMilli))
        throw new Error('AI credit total exceeds safe integer range');
      await tx.execute(sql`update ai_credit_attempts set status = ${complete ? 'settled' : 'expired'}, reserved_tokens = ${complete ? 0 : Number(row.reserved_tokens)},
        input_tokens = ${measuredInput}, output_tokens = ${measuredOutput}, credits_milli = ${creditsMilli}, settled_at = ${this.clock()}
        where tenant_id = ${reservation.tenantId}::uuid and id = ${reservation.id}::uuid`);
      if (row.source === 'managed') {
        const runId = row.attribution?.runId;
        const sourceRef =
          typeof runId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)
            ? toPublicId('run', runId)
            : row.attempt_key;
        const period = periodOf(this.clock());
        for (const [meter, quantity] of [
          ['ai.tokens.input', measuredInput],
          ['ai.tokens.output', measuredOutput],
        ] as const) {
          if (quantity === null) continue;
          await tx.execute(sql`insert into usage_entries
            (id, tenant_id, meter, quantity, unit, occurred_at, dedupe_key, source_ref)
            values (${newId()}::uuid, ${reservation.tenantId}::uuid, ${meter}, ${quantity}, 'token',
              ${period.key === row.period_key ? this.clock() : new Date(periodOf(new Date(`${row.period_key}-01T00:00:00Z`)).end.getTime() - 1)},
              ${`ai:${row.attempt_key}:${meter}`}, ${sourceRef}) on conflict (tenant_id, dedupe_key) do update set quantity = excluded.quantity`);
        }
      }
    });
  }

  async release(reservation: AiReservation): Promise<void> {
    await this.tx(reservation.tenantId, async (tx) => {
      await tx.execute(sql`select app.lock_ai_payer()`);
      await this.lock(tx, reservation.tenantId);
      await tx.execute(sql`update ai_credit_attempts set status = 'released', reserved_tokens = 0,
        settled_at = ${this.clock()} where tenant_id = ${reservation.tenantId}::uuid
        and id = ${reservation.id}::uuid and lease_token = ${reservation.leaseToken}::uuid
        and status in ('reserved', 'expired')`);
    });
  }

  async overview(tenantId: string) {
    const period = periodOf(this.clock());
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.execute<{
        attempt_key: string;
        source: AiSource;
        status: string;
        provider: string;
        model_id: string;
        period_key: string;
        reserved_tokens: string;
        input_tokens: string | null;
        output_tokens: string | null;
        credits_milli: string;
        rate_version: number | null;
        attribution: Record<string, unknown>;
        created_at: string | Date;
      }>(sql`select attempt_key, source, status, provider, model_id, period_key, reserved_tokens,
          input_tokens, output_tokens, credits_milli, rate_version, attribution, created_at
        from ai_credit_attempts where tenant_id = ${tenantId}::uuid and period_key = ${period.key}
        order by created_at desc limit 100`);
      const attempts = rows.map((row) => ({
        key: row.attempt_key,
        source: row.source,
        status: row.status,
        provider: row.provider,
        modelId: row.model_id,
        periodKey: row.period_key,
        reservedTokens: Number(row.reserved_tokens),
        inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
        outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
        creditsMilli: Number(row.credits_milli),
        rateVersion: row.rate_version,
        attribution: row.attribution,
        createdAt: new Date(row.created_at).toISOString(),
      }));
      const all = await tx.execute<{
        source: AiSource;
        status: string;
        reserved: string;
        input: string;
        output: string;
        credits: string;
      }>(sql`
        select source, status, coalesce(sum(reserved_tokens),0)::text as reserved,
          coalesce(sum(input_tokens),0)::text as input, coalesce(sum(output_tokens),0)::text as output,
          coalesce(sum(credits_milli),0)::text as credits
        from ai_credit_attempts where tenant_id = ${tenantId}::uuid and period_key = ${period.key}
        group by source, status`);
      const managed = { settledTokens: 0, reservedTokens: 0, creditsMilli: 0 };
      const byok = { tokens: 0 };
      for (const row of all.rows) {
        if (row.source === 'managed') {
          if (row.status === 'reserved' || row.status === 'expired')
            managed.reservedTokens += Number(row.reserved);
          if (row.status === 'settled' || row.status === 'expired') {
            managed.settledTokens += Number(row.input) + Number(row.output);
            managed.creditsMilli += Number(row.credits);
          }
        } else if (row.status === 'settled' || row.status === 'expired')
          byok.tokens += Number(row.input) + Number(row.output);
      }
      const payer = await tx.execute<{ payer: string }>(sql`select app.ai_payer_tenant() as payer`);
      return {
        payerTenantId: payer.rows[0]?.payer ?? tenantId,
        period: {
          key: period.key,
          start: period.start.toISOString(),
          end: period.end.toISOString(),
        },
        managed,
        byok,
        attempts,
      };
    });
  }
}
