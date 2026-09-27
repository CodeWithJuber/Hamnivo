import type {
  CustomerMemory,
  IdKind,
  MemoryChange,
  MemoryConsent,
  MemoryDeletionReceipt,
  SetMemoryConsentRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { MEMORY_MAX_RETENTION_DAYS } from '@hamnivo/domain';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { AgentsService } from '../runtime/agents.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { MemoryCache } from './cache.js';
import { MemoryDeletionService } from './deletion.service.js';
import { consentView, currentItems, type MemoryRow, memoryItemView, receiptView } from './views.js';
import { type MemorySubject, MemoryWriter, type WriteResult } from './writer.service.js';

/** Parses a public id of the given kind; a malformed or foreign id is simply not found. */
export function internalId(kind: IdKind, publicId: string) {
  try {
    return fromPublicId(kind, publicId);
  } catch (error) {
    if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
    throw error;
  }
}

/** Turns a refused or unexpected policy outcome into a change result or a clear error. */
export function changeOf(
  result: WriteResult,
  audience: 'customer' | 'staff',
  success: 'corrected' | 'confirmed',
): MemoryChange {
  const { decision, record } = result;
  if (decision.outcome === 'refuse' || !record) {
    throw new AppError('VALIDATION_FAILED', {
      detail: decision.explanation,
      fields: [{ path: 'value', message: decision.explanation }],
    });
  }
  return {
    outcome: decision.outcome === 'unchanged' ? 'unchanged' : success,
    memory: memoryItemView(record, { audience }),
    explanation: decision.explanation,
  };
}

/**
 * The customer's own memory, from the widget (L04): see what is remembered, agree or turn memory
 * off, correct, confirm and delete. Every query is bound to the session's customer, so no one can
 * reach another customer's memory, even in the same brand.
 */
@Injectable()
export class CustomerMemoryService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly agents: AgentsService,
    private readonly writer: MemoryWriter,
    private readonly deletions: MemoryDeletionService,
    private readonly cache: MemoryCache,
  ) {}

  private tx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  private async subject(tx: TenantTx, claims: WidgetClaims): Promise<MemorySubject> {
    const [brand] = await tx
      .select({ workspaceId: schema.brands.workspaceId })
      .from(schema.brands)
      .where(eq(schema.brands.id, claims.brandId));
    if (!brand) throw new AppError('NOT_FOUND');
    return {
      tenantId: claims.tenantId,
      id: claims.principalId,
      verified: claims.verified,
      brandId: claims.brandId,
      workspaceId: brand.workspaceId,
    };
  }

  /** One of the customer's own records; anything else is not found. */
  private async own(tx: TenantTx, claims: WidgetClaims, publicId: string): Promise<MemoryRow> {
    const r = schema.memoryRecords;
    const [row] = await tx
      .select()
      .from(r)
      .where(
        and(
          eq(r.id, internalId('memory', publicId)),
          eq(r.subjectId, claims.principalId),
          eq(r.brandId, claims.brandId),
        ),
      );
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Memory not found.' });
    return row;
  }

  async get(claims: WidgetClaims): Promise<CustomerMemory> {
    return this.tx(claims, async (tx) => {
      const agent = await this.agents.activeFor(tx, claims.brandId);
      const consent = await this.writer.latestConsent(tx, claims.principalId);
      const rows = await this.writer.records(tx, claims.principalId);
      return {
        offered: agent?.config.memory.enabled ?? false,
        consent: consentView(consent),
        items: currentItems(
          rows.filter((row) => row.brandId === claims.brandId),
          'customer',
        ),
        maxRetentionDays: MEMORY_MAX_RETENTION_DAYS,
      };
    });
  }

  async setConsent(
    claims: WidgetClaims,
    input: z.output<typeof SetMemoryConsentRequest>,
  ): Promise<MemoryConsent> {
    const consent = await this.tx(claims, async (tx) => {
      const [row] = await tx
        .insert(schema.learningConsents)
        .values({
          tenantId: claims.tenantId,
          brandId: claims.brandId,
          subjectId: claims.principalId,
          scope: 'personal_memory',
          state: input.state,
          noticeVersion: input.noticeVersion,
          actorType: 'customer',
          actorId: toPublicId('customer', claims.principalId),
          createdAt: this.clock(),
        })
        .returning();
      await appendAudit(tx, {
        actorType: 'customer',
        actorId: toPublicId('customer', claims.principalId),
        action: 'memory.consent_changed',
        targetType: 'customer',
        targetId: toPublicId('customer', claims.principalId),
        outcome: 'success',
        data: { scope: 'personal_memory', state: input.state, noticeVersion: input.noticeVersion },
      });
      return row;
    });
    // Replies built with the customer's memory stop reusing it at once.
    await this.cache.bump(claims.tenantId, claims.principalId);
    return consentView(consent);
  }

  async correct(claims: WidgetClaims, memoryId: string, value: string): Promise<MemoryChange> {
    const result = await this.tx(claims, async (tx) => {
      const subject = await this.subject(tx, claims);
      await this.writer.lock(tx, subject);
      const target = await this.own(tx, claims, memoryId);
      return this.writer.correct(tx, subject, { actor: { kind: 'customer' }, target, value });
    });
    const change = changeOf(result, 'customer', 'corrected');
    await this.cache.bump(claims.tenantId, claims.principalId);
    return change;
  }

  async confirm(claims: WidgetClaims, memoryId: string): Promise<MemoryChange> {
    const result = await this.tx(claims, async (tx) => {
      const subject = await this.subject(tx, claims);
      await this.writer.lock(tx, subject);
      const target = await this.own(tx, claims, memoryId);
      return this.writer.confirm(tx, subject, { actor: { kind: 'customer' }, target });
    });
    const change = changeOf(result, 'customer', 'confirmed');
    await this.cache.bump(claims.tenantId, claims.principalId);
    return change;
  }

  /**
   * Forgets one memory. A current value goes with its whole history (every version of the slot);
   * a value waiting for review goes alone.
   */
  async delete(claims: WidgetClaims, memoryId: string): Promise<MemoryDeletionReceipt> {
    const receipt = await this.tx(claims, async (tx) => {
      const subject = await this.subject(tx, claims);
      await this.writer.lock(tx, subject);
      const target = await this.own(tx, claims, memoryId);
      const records =
        target.status === 'pending'
          ? [target]
          : await this.writer.records(tx, claims.principalId, target.key);
      return this.deletions.delete(tx, {
        subject,
        records,
        scope: 'record',
        reason: 'customer_request',
        requestedBy: { type: 'customer', id: toPublicId('customer', claims.principalId) },
      });
    });
    return receiptView(receipt, 'customer');
  }

  /** Forgets everything remembered about the customer (right to erasure, from the widget). */
  async forget(claims: WidgetClaims): Promise<MemoryDeletionReceipt> {
    const receipt = await this.tx(claims, async (tx) => {
      const subject = await this.subject(tx, claims);
      await this.writer.lock(tx, subject);
      const records = await this.writer.records(tx, claims.principalId);
      return this.deletions.delete(tx, {
        subject,
        records,
        scope: 'customer',
        reason: 'customer_request',
        requestedBy: { type: 'customer', id: toPublicId('customer', claims.principalId) },
      });
    });
    return receiptView(receipt, 'customer');
  }

  async deletion(claims: WidgetClaims, deletionId: string): Promise<MemoryDeletionReceipt> {
    return this.tx(claims, async (tx) => {
      const d = schema.memoryDeletions;
      const [row] = await tx
        .select()
        .from(d)
        .where(
          and(
            eq(d.id, internalId('memoryDeletion', deletionId)),
            eq(d.subjectId, claims.principalId),
          ),
        );
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Deletion not found.' });
      return receiptView(row, 'customer');
    });
  }
}
