import type {
  EraseCustomerMemoryRequest,
  MemoryChange,
  MemoryCustomerDetail,
  MemoryCustomerSummary,
  MemoryDeletionReceipt,
  MemoryExport,
  StaffCorrectMemoryRequest,
} from '@hamnivo/contracts';
import { MEMORY_NOTICE_VERSION } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { MEMORY_POLICY_VERSION } from '@hamnivo/domain';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { AgentsService } from '../runtime/agents.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { MemoryCache } from './cache.js';
import { changeOf, internalId } from './customer-memory.service.js';
import { MemoryDeletionService } from './deletion.service.js';
import {
  consentView,
  currentItems,
  type DeletionRow,
  type MemoryRow,
  memoryItemView,
  receiptView,
} from './views.js';
import { type MemorySubject, MemoryWriter } from './writer.service.js';

type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;
type BrandRow = typeof schema.brands.$inferSelect;

interface Customer {
  principal: PrincipalRow;
  brand: BrandRow;
  subject: MemorySubject;
}

function customerRef(principal: PrincipalRow) {
  return {
    id: toPublicId('customer', principal.id),
    brandId: toPublicId('brand', principal.brandId),
    displayName: principal.displayName,
    email: principal.email,
    verified: principal.kind === 'verified',
    since: principal.createdAt.toISOString(),
  };
}

/**
 * Customer memory in Studio (L04, L05): staff see provenance, history and deletions, correct,
 * confirm, mark outdated, delete and erase, within their grants. Every change is authorized with
 * @hamnivo/policy for the customer's brand and audited.
 */
@Injectable()
export class AdminMemoryService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly agents: AgentsService,
    private readonly writer: MemoryWriter,
    private readonly deletions: MemoryDeletionService,
    private readonly cache: MemoryCache,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private allowed(principal: StaffPrincipal, permission: Permission, brand: BrandRow) {
    return authorize(
      principal,
      permission,
      { workspaceId: brand.workspaceId, brandId: brand.id },
      { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
    );
  }

  private async customer(tx: TenantTx, publicId: string): Promise<Customer> {
    const [row] = await tx
      .select({ principal: schema.customerPrincipals, brand: schema.brands })
      .from(schema.customerPrincipals)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.customerPrincipals.brandId))
      .where(eq(schema.customerPrincipals.id, internalId('customer', publicId)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Customer not found.' });
    return {
      ...row,
      subject: {
        tenantId: row.principal.tenantId,
        id: row.principal.id,
        verified: row.principal.kind === 'verified',
        brandId: row.brand.id,
        workspaceId: row.brand.workspaceId,
      },
    };
  }

  /** A record with its customer, after checking `permission` for the customer's brand. */
  private async record(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
  ): Promise<{ row: MemoryRow; customer: Customer }> {
    const [row] = await tx
      .select()
      .from(schema.memoryRecords)
      .where(eq(schema.memoryRecords.id, internalId('memory', publicId)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Memory not found.' });
    const customer = await this.customer(tx, toPublicId('customer', row.subjectId));
    enforce(this.allowed(principal, permission, customer.brand));
    return { row, customer };
  }

  /** Display names of the people and agents that wrote records or asked for deletions. */
  private async names(tx: TenantTx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    const names = new Map<string, string>();
    const staff = unique.filter((id) => id.startsWith('stf_'));
    const agents = unique.filter((id) => id.startsWith('agt_'));
    const customers = unique.filter((id) => id.startsWith('cus_'));
    if (staff.length) {
      const rows = await tx
        .select({ id: schema.staffMembers.id, name: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(
          inArray(
            schema.staffMembers.id,
            staff.map((id) => fromPublicId('staff', id)),
          ),
        );
      for (const row of rows) names.set(toPublicId('staff', row.id), row.name);
    }
    if (agents.length) {
      const rows = await tx
        .select({ id: schema.agentProfiles.id, name: schema.agentProfiles.name })
        .from(schema.agentProfiles)
        .where(
          inArray(
            schema.agentProfiles.id,
            agents.map((id) => fromPublicId('agent', id)),
          ),
        );
      for (const row of rows) names.set(toPublicId('agent', row.id), row.name);
    }
    if (customers.length) {
      const rows = await tx
        .select({ id: schema.customerPrincipals.id, name: schema.customerPrincipals.displayName })
        .from(schema.customerPrincipals)
        .where(
          inArray(
            schema.customerPrincipals.id,
            customers.map((id) => fromPublicId('customer', id)),
          ),
        );
      for (const row of rows) if (row.name) names.set(toPublicId('customer', row.id), row.name);
    }
    return names;
  }

  async list(
    principal: StaffPrincipal,
    query: { brandId?: string | undefined; query?: string | undefined; limit: number },
  ): Promise<MemoryCustomerSummary[]> {
    return this.tx(principal, async (tx) => {
      const brands = (await tx.select().from(schema.brands)).filter(
        (brand) => this.allowed(principal, 'memory.read', brand).allowed,
      );
      let brandIds = brands.map((brand) => brand.id);
      if (query.brandId) {
        const [brand] = await tx
          .select()
          .from(schema.brands)
          .where(eq(schema.brands.id, internalId('brand', query.brandId)));
        if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
        enforce(this.allowed(principal, 'memory.read', brand));
        brandIds = [brand.id];
      }
      if (brandIds.length === 0) return [];
      const search = query.query?.trim()
        ? `%${query.query.trim().replace(/[%_\\]/g, '\\$&')}%`
        : null;
      const { rows } = await tx.execute<{
        id: string;
        consent: 'granted' | 'declined' | 'withdrawn' | null;
        active: string;
        pending: string;
        last_changed: Date | null;
      }>(sql`
        select p.id,
          (select c.state from learning_consents c
            where c.subject_id = p.id and c.scope = 'personal_memory'
            order by c.created_at desc, c.id desc limit 1) as consent,
          (select count(*) from memory_records r where r.subject_id = p.id and r.status = 'active') as active,
          (select count(*) from memory_records r where r.subject_id = p.id and r.status = 'pending') as pending,
          greatest(
            (select max(r.updated_at) from memory_records r where r.subject_id = p.id),
            (select max(c.created_at) from learning_consents c where c.subject_id = p.id)
          ) as last_changed
        from customer_principals p
        where p.brand_id in (${sql.join(
          brandIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          and (exists (select from memory_records r where r.subject_id = p.id)
               or exists (select from learning_consents c where c.subject_id = p.id))
          ${
            search
              ? sql`and (p.display_name ilike ${search} or p.email::text ilike ${search}
                         or p.external_subject ilike ${search})`
              : sql``
          }
        order by last_changed desc nulls last, p.id
        limit ${query.limit}`);
      if (rows.length === 0) return [];
      const principals = await tx
        .select()
        .from(schema.customerPrincipals)
        .where(
          inArray(
            schema.customerPrincipals.id,
            rows.map((row) => row.id),
          ),
        );
      const byId = new Map(principals.map((row) => [row.id, row]));
      return rows.flatMap((row) => {
        const found = byId.get(row.id);
        if (!found) return [];
        return [
          {
            customer: customerRef(found),
            consent: row.consent ?? 'undecided',
            active: Number(row.active),
            pending: Number(row.pending),
            lastChangedAt: row.last_changed ? new Date(row.last_changed).toISOString() : null,
          },
        ];
      });
    });
  }

  private async consentHistory(tx: TenantTx, subjectId: string) {
    const c = schema.learningConsents;
    const rows = await tx
      .select()
      .from(c)
      .where(and(eq(c.subjectId, subjectId), eq(c.scope, 'personal_memory')))
      .orderBy(desc(c.createdAt), desc(c.id));
    return rows;
  }

  private async deletionRows(tx: TenantTx, subjectId: string, limit = 20): Promise<DeletionRow[]> {
    const d = schema.memoryDeletions;
    return tx
      .select()
      .from(d)
      .where(eq(d.subjectId, subjectId))
      .orderBy(desc(d.createdAt), desc(d.id))
      .limit(limit);
  }

  async detail(principal: StaffPrincipal, customerId: string): Promise<MemoryCustomerDetail> {
    return this.tx(principal, async (tx) => {
      const customer = await this.customer(tx, customerId);
      enforce(this.allowed(principal, 'memory.read', customer.brand));
      const agent = await this.agents.activeFor(tx, customer.brand.id);
      const consents = await this.consentHistory(tx, customer.principal.id);
      const rows = await this.writer.records(tx, customer.principal.id);
      const deletions = await this.deletionRows(tx, customer.principal.id);
      const names = await this.names(tx, [
        ...rows.map((row) => row.writtenById),
        ...deletions.map((row) => row.requestedById),
      ]);
      return {
        customer: customerRef(customer.principal),
        offered: agent?.config.memory.enabled ?? false,
        consent: consentView(consents[0]),
        consentHistory: consents.map((row) => ({
          ...consentView(row),
          decidedBy: row.actorType,
        })),
        items: currentItems(rows, 'staff', names),
        history: rows
          .filter((row) => row.status === 'superseded' || row.status === 'outdated')
          .sort(
            (a, b) =>
              (b.supersededAt?.getTime() ?? 0) - (a.supersededAt?.getTime() ?? 0) ||
              b.version - a.version,
          )
          .map((row) => memoryItemView(row, { audience: 'staff', names })),
        deletions: deletions.map((row) => receiptView(row, 'staff', names)),
      };
    });
  }

  async correct(
    principal: StaffPrincipal,
    memoryId: string,
    input: z.output<typeof StaffCorrectMemoryRequest>,
  ): Promise<MemoryChange> {
    const { result, subjectId } = await this.tx(principal, async (tx) => {
      const { row, customer } = await this.record(tx, principal, memoryId, 'memory.manage');
      await this.writer.lock(tx, customer.subject);
      const [target] = await this.writer.byIds(tx, customer.subject.id, [row.id]);
      if (!target) throw new AppError('NOT_FOUND', { detail: 'Memory not found.' });
      const result = await this.writer.correct(tx, customer.subject, {
        actor: { kind: 'staff', staffId: principal.staffMemberId, authorized: true },
        target,
        value: input.value,
        note: input.reason,
        validFrom: input.validFrom ? new Date(input.validFrom) : null,
      });
      return { result, subjectId: customer.subject.id };
    });
    const change = changeOf(result, 'staff', 'corrected');
    await this.cache.bump(principal.tenantId, subjectId);
    return change;
  }

  async confirm(
    principal: StaffPrincipal,
    memoryId: string,
    reason: string,
  ): Promise<MemoryChange> {
    const { result, subjectId } = await this.tx(principal, async (tx) => {
      const { customer } = await this.record(tx, principal, memoryId, 'memory.manage');
      await this.writer.lock(tx, customer.subject);
      const [target] = await this.writer.byIds(tx, customer.subject.id, [
        internalId('memory', memoryId),
      ]);
      if (!target) throw new AppError('NOT_FOUND', { detail: 'Memory not found.' });
      const result = await this.writer.confirm(tx, customer.subject, {
        actor: { kind: 'staff', staffId: principal.staffMemberId, authorized: true },
        target,
      });
      if (result.record)
        await this.note(tx, principal, 'memory.confirm_reason', result.record, reason);
      return { result, subjectId: customer.subject.id };
    });
    const change = changeOf(result, 'staff', 'confirmed');
    await this.cache.bump(principal.tenantId, subjectId);
    return change;
  }

  /** The reason staff gave, kept in the audit log with the change. */
  private note(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    row: MemoryRow,
    reason: string,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'memory',
      targetId: toPublicId('memory', row.id),
      outcome: 'success',
      reason,
      data: { customerId: toPublicId('customer', row.subjectId), key: row.key },
    });
  }

  async outdate(
    principal: StaffPrincipal,
    memoryId: string,
    reason: string,
  ): Promise<MemoryChange> {
    const { record, subjectId } = await this.tx(principal, async (tx) => {
      const { customer } = await this.record(tx, principal, memoryId, 'memory.manage');
      await this.writer.lock(tx, customer.subject);
      const [target] = await this.writer.byIds(tx, customer.subject.id, [
        internalId('memory', memoryId),
      ]);
      if (target?.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Only a current value can be marked outdated.',
        });
      }
      const record = await this.writer.outdate(tx, customer.subject, {
        actor: { kind: 'staff', staffId: principal.staffMemberId, authorized: true },
        target,
      });
      await this.note(tx, principal, 'memory.outdated_reason', record, reason);
      return { record, subjectId: customer.subject.id };
    });
    await this.cache.bump(principal.tenantId, subjectId);
    return {
      outcome: 'outdated',
      memory: memoryItemView(record, { audience: 'staff' }),
      explanation: 'Outdated: it is no longer used, and it stays in the history.',
    };
  }

  private async deleteRecords(
    principal: StaffPrincipal,
    memoryId: string,
    input: { permission: Permission; reason: string; pendingOnly: boolean },
  ): Promise<MemoryDeletionReceipt> {
    return this.tx(principal, async (tx) => {
      const { customer } = await this.record(tx, principal, memoryId, input.permission);
      await this.writer.lock(tx, customer.subject);
      const [target] = await this.writer.byIds(tx, customer.subject.id, [
        internalId('memory', memoryId),
      ]);
      if (!target) throw new AppError('NOT_FOUND', { detail: 'Memory not found.' });
      if (input.pendingOnly && target.status !== 'pending') {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Only a value waiting for review can be rejected.',
        });
      }
      const records =
        target.status === 'pending'
          ? [target]
          : await this.writer.records(tx, customer.subject.id, target.key);
      const receipt = await this.deletions.delete(tx, {
        subject: customer.subject,
        records,
        scope: 'record',
        reason: input.pendingOnly ? 'review_rejected' : 'staff_request',
        requestedBy: { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: input.pendingOnly ? 'memory.rejected_reason' : 'memory.deleted_reason',
        targetType: 'memory_deletion',
        targetId: toPublicId('memoryDeletion', receipt.id),
        outcome: 'success',
        reason: input.reason,
        data: { customerId: toPublicId('customer', customer.subject.id) },
      });
      const names = await this.names(tx, [receipt.requestedById]);
      return receiptView(receipt, 'staff', names);
    });
  }

  reject(principal: StaffPrincipal, memoryId: string, reason: string) {
    return this.deleteRecords(principal, memoryId, {
      permission: 'memory.manage',
      reason,
      pendingOnly: true,
    });
  }

  delete(principal: StaffPrincipal, memoryId: string, reason: string) {
    return this.deleteRecords(principal, memoryId, {
      permission: 'memory.delete',
      reason,
      pendingOnly: false,
    });
  }

  /** Right to erasure: everything remembered about the customer, and optionally memory off. */
  async erase(
    principal: StaffPrincipal,
    customerId: string,
    input: z.output<typeof EraseCustomerMemoryRequest>,
  ): Promise<MemoryDeletionReceipt> {
    return this.tx(principal, async (tx) => {
      const customer = await this.customer(tx, customerId);
      enforce(this.allowed(principal, 'memory.erase', customer.brand));
      await this.writer.lock(tx, customer.subject);
      const records = await this.writer.records(tx, customer.subject.id);
      const staffId = toPublicId('staff', principal.staffMemberId);
      const receipt = await this.deletions.delete(tx, {
        subject: customer.subject,
        records,
        scope: 'customer',
        reason: 'erasure_request',
        requestedBy: { type: 'staff', id: staffId },
      });
      if (input.turnOff) {
        await tx.insert(schema.learningConsents).values({
          tenantId: principal.tenantId,
          brandId: customer.brand.id,
          subjectId: customer.subject.id,
          scope: 'personal_memory',
          state: 'withdrawn',
          noticeVersion: MEMORY_NOTICE_VERSION,
          actorType: 'staff',
          actorId: staffId,
          createdAt: this.clock(),
        });
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: staffId,
        action: 'memory.erased_reason',
        targetType: 'memory_deletion',
        targetId: toPublicId('memoryDeletion', receipt.id),
        outcome: 'success',
        reason: input.reason,
        data: { customerId, turnedOff: input.turnOff },
      });
      const names = await this.names(tx, [staffId]);
      return receiptView(receipt, 'staff', names);
    });
  }

  /** Everything remembered about one customer, for an access request (audited). */
  async export(principal: StaffPrincipal, customerId: string): Promise<MemoryExport> {
    return this.tx(principal, async (tx) => {
      const customer = await this.customer(tx, customerId);
      enforce(this.allowed(principal, 'memory.export', customer.brand));
      const consents = await this.consentHistory(tx, customer.principal.id);
      const rows = await this.writer.records(tx, customer.principal.id);
      const deletions = await this.deletionRows(tx, customer.principal.id, 1000);
      const names = await this.names(tx, [
        ...rows.map((row) => row.writtenById),
        ...deletions.map((row) => row.requestedById),
      ]);
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'memory.exported',
        targetType: 'customer',
        targetId: customerId,
        outcome: 'success',
        data: { records: rows.length },
      });
      return {
        exportedAt: this.clock().toISOString(),
        policyVersion: MEMORY_POLICY_VERSION,
        customer: customerRef(customer.principal),
        consentHistory: consents.map((row) => ({ ...consentView(row), decidedBy: row.actorType })),
        records: rows.map((row) => memoryItemView(row, { audience: 'staff', names })),
        deletions: deletions.map((row) => receiptView(row, 'staff', names)),
      };
    });
  }

  async deletion(principal: StaffPrincipal, deletionId: string): Promise<MemoryDeletionReceipt> {
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select({ deletion: schema.memoryDeletions, brand: schema.brands })
        .from(schema.memoryDeletions)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.memoryDeletions.brandId))
        .where(eq(schema.memoryDeletions.id, internalId('memoryDeletion', deletionId)));
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Deletion not found.' });
      enforce(this.allowed(principal, 'memory.read', row.brand));
      const names = await this.names(tx, [row.deletion.requestedById]);
      return receiptView(row.deletion, 'staff', names);
    });
  }
}
