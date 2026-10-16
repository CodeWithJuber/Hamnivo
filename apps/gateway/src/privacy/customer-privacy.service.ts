import type {
  EraseCustomerRequest,
  ExportCustomerRequest,
  PrivacyCustomer,
  PrivacyCustomerSummary,
  PrivacyRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, ilike, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuthorityRegistry } from '../authority/registry.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { internalId } from '../memory/customer-memory.service.js';
import { importerFor } from '../migration/destination.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

export const PRIVACY_EXPORT_TOPIC = 'privacy.export';
export const PRIVACY_ERASE_TOPIC = 'privacy.erase';

type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;
type BrandRow = typeof schema.brands.$inferSelect;
type RequestRow = typeof schema.privacyRequests.$inferSelect;

const EITHER: Permission[] = ['customers.export', 'customers.erase'];

/** `%` and `_` typed by a person are characters, not patterns. */
const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A customer or conversation ID typed into the search, as staff copy it from Studio. */
function typedId(kind: 'customer' | 'conversation', text: string): string | null {
  try {
    return fromPublicId(kind, text.trim().toLowerCase());
  } catch {
    return null;
  }
}

export function customerView(principal: PrincipalRow, brand: BrandRow): PrivacyCustomer {
  return {
    id: toPublicId('customer', principal.id),
    brand: { id: toPublicId('brand', brand.id), name: brand.name },
    kind: principal.kind,
    name: principal.displayName,
    email: principal.email,
    externalId: principal.externalSubject,
    channel:
      principal.channelKind && principal.channelHandle
        ? { kind: principal.channelKind, handle: principal.channelHandle }
        : null,
    lastSeenAt: principal.lastSeenAt?.toISOString() ?? null,
    erasedAt: principal.erasedAt?.toISOString() ?? null,
  };
}

/**
 * One customer's data on request (A10): find a customer in the brands one may handle, see what
 * an export or erasure covers, and ask for either. The worker does the work (PrivacyWorker);
 * requests are receipts, and every step is audited without personal data.
 */
@Injectable()
export class CustomerPrivacyService {
  private readonly logger = new Logger(CustomerPrivacyService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
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

  /** Allowed for either permission, or the first refusal (so its reason, e.g. MFA, is shown). */
  private either(principal: StaffPrincipal, brand: BrandRow) {
    const decisions = EITHER.map((permission) => this.allowed(principal, permission, brand));
    return decisions.find((d) => d.allowed) ?? decisions[0];
  }

  private async brandsFor(tx: TenantTx, principal: StaffPrincipal): Promise<BrandRow[]> {
    const brands = await tx.select().from(schema.brands);
    return brands.filter((brand) => this.either(principal, brand)?.allowed);
  }

  private async customer(tx: TenantTx, publicId: string) {
    const [row] = await tx
      .select({ principal: schema.customerPrincipals, brand: schema.brands })
      .from(schema.customerPrincipals)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.customerPrincipals.brandId))
      .where(eq(schema.customerPrincipals.id, internalId('customer', publicId)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Customer not found.' });
    return row;
  }

  async search(
    principal: StaffPrincipal,
    query: { query: string; brandId?: string | undefined },
  ): Promise<{ items: PrivacyCustomer[] }> {
    return this.tx(principal, async (tx) => {
      let brands = await this.brandsFor(tx, principal);
      if (query.brandId) {
        const wanted = internalId('brand', query.brandId);
        brands = brands.filter((brand) => brand.id === wanted);
      }
      if (brands.length === 0) throw new AppError('SCOPE_DENIED');
      const c = schema.customerPrincipals;
      const text = like(query.query);
      const customerId = typedId('customer', query.query);
      const conversationId = typedId('conversation', query.query);
      const rows = await tx
        .select()
        .from(c)
        .where(
          and(
            inArray(
              c.brandId,
              brands.map((brand) => brand.id),
            ),
            or(
              ilike(c.displayName, text),
              ilike(sql`${c.email}::text`, text),
              ilike(c.externalSubject, text),
              ilike(sql`${c.channelHandle}::text`, text),
              ...(customerId ? [eq(c.id, customerId)] : []),
              ...(conversationId
                ? [
                    inArray(
                      c.id,
                      tx
                        .select({ id: schema.conversationControls.principalId })
                        .from(schema.conversationControls)
                        .where(eq(schema.conversationControls.id, conversationId)),
                    ),
                  ]
                : []),
            ),
          ),
        )
        .orderBy(sql`${c.lastSeenAt} desc nulls last`, desc(c.createdAt))
        .limit(50);
      const byId = new Map(brands.map((brand) => [brand.id, brand]));
      return {
        items: rows.map((row) => customerView(row, byId.get(row.brandId) as BrandRow)),
      };
    });
  }

  async summary(principal: StaffPrincipal, customerId: string): Promise<PrivacyCustomerSummary> {
    const found = await this.tx(principal, async (tx) => {
      const { principal: who, brand } = await this.customer(tx, customerId);
      enforce(this.either(principal, brand) as Parameters<typeof enforce>[0]);
      const [conversations] = await tx
        .select({ n: count() })
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.principalId, who.id));
      const [orders] = await tx
        .select({ n: count() })
        .from(schema.orders)
        .where(eq(schema.orders.principalId, who.id));
      const [memories] = await tx
        .select({ n: count() })
        .from(schema.memoryRecords)
        .where(eq(schema.memoryRecords.subjectId, who.id));
      const contacts = await tx
        .select({
          connectionId: schema.authorityContacts.connectionId,
          externalContactId: schema.authorityContacts.externalContactId,
        })
        .from(schema.authorityContacts)
        .where(
          and(
            eq(schema.authorityContacts.principalId, who.id),
            isNotNull(schema.authorityContacts.externalContactId),
          ),
        );
      const inboxes = await tx
        .select({
          connectionId: schema.authorityInboxes.connectionId,
          externalInboxId: schema.authorityInboxes.externalInboxId,
        })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.brandId, brand.id));
      const requests = await this.requestRows(tx, [brand], who.id);
      return {
        who,
        brand,
        counts: {
          conversations: Number(conversations?.n ?? 0),
          orders: Number(orders?.n ?? 0),
          memories: Number(memories?.n ?? 0),
        },
        contacts,
        inboxes,
        requests,
      };
    });
    return {
      customer: customerView(found.who, found.brand),
      ...found.counts,
      sharedContact: await this.sharedContact(principal.tenantId, found.contacts, found.inboxes),
      requests: found.requests,
    };
  }

  /** Whether a Chatwoot contact of the customer also has conversations of another brand. */
  private async sharedContact(
    tenantId: string,
    contacts: { connectionId: string; externalContactId: number | null }[],
    inboxes: { connectionId: string; externalInboxId: number }[],
  ): Promise<boolean> {
    for (const contact of contacts) {
      if (contact.externalContactId === null) continue;
      try {
        const runtime = await this.registry.get(tenantId, contact.connectionId);
        const mine = new Set(
          inboxes
            .filter((i) => i.connectionId === contact.connectionId)
            .map((i) => i.externalInboxId),
        );
        const conversations = await importerFor(runtime, this.config).listContactConversations(
          contact.externalContactId,
        );
        if (conversations.some((c) => !mine.has(c.inboxId))) return true;
      } catch (error) {
        // Only a warning on the page: what Chatwoot cannot tell now is not shown.
        this.logger.warn(`contact lookup failed: ${String(error)}`);
      }
    }
    return false;
  }

  private async request(
    principal: StaffPrincipal,
    customerId: string,
    kind: 'export' | 'erase',
    input: { reason: RequestRow['reason']; reference?: string | undefined },
  ): Promise<PrivacyRequest> {
    return this.tx(principal, async (tx) => {
      const { principal: who, brand } = await this.customer(tx, customerId);
      enforce(
        this.allowed(principal, kind === 'export' ? 'customers.export' : 'customers.erase', brand),
      );
      const t = schema.privacyRequests;
      // Asking again while one runs gives the one that runs.
      const [open] = await tx
        .select()
        .from(t)
        .where(
          and(eq(t.principalId, who.id), eq(t.kind, kind), inArray(t.state, ['queued', 'running'])),
        )
        .limit(1);
      if (open) return (await this.views(tx, [open]))[0] as PrivacyRequest;
      const [row] = await tx
        .insert(t)
        .values({
          tenantId: principal.tenantId,
          kind,
          brandId: brand.id,
          principalId: who.id,
          reason: input.reason,
          reference: input.reference ?? null,
          requestedBy: principal.staffMemberId,
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .returning();
      if (!row) throw new Error('privacy request insert returned nothing');
      await enqueueOutbox(tx, principal.tenantId, {
        topic: kind === 'export' ? PRIVACY_EXPORT_TOPIC : PRIVACY_ERASE_TOPIC,
        aggregateType: 'privacy_request',
        aggregateId: row.id,
        payload: { requestId: row.id },
      });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: kind === 'export' ? 'privacy.export_requested' : 'privacy.erase_requested',
        targetType: 'customer',
        targetId: customerId,
        outcome: 'success',
        data: {
          requestId: toPublicId('privacyRequest', row.id),
          reason: input.reason,
          ...(input.reference ? { reference: input.reference } : {}),
        },
        occurredAt: this.clock(),
      });
      return (await this.views(tx, [row]))[0] as PrivacyRequest;
    });
  }

  requestExport(
    principal: StaffPrincipal,
    customerId: string,
    input: z.output<typeof ExportCustomerRequest>,
  ): Promise<PrivacyRequest> {
    return this.request(principal, customerId, 'export', input);
  }

  requestErase(
    principal: StaffPrincipal,
    customerId: string,
    input: z.output<typeof EraseCustomerRequest>,
  ): Promise<PrivacyRequest> {
    if (input.confirm.toLowerCase() !== customerId.toLowerCase()) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'confirm', message: 'Type the customer’s ID exactly as shown.' }],
      });
    }
    return this.request(principal, customerId, 'erase', input);
  }

  private async requestRows(
    tx: TenantTx,
    brands: BrandRow[],
    principalId?: string,
  ): Promise<PrivacyRequest[]> {
    if (brands.length === 0) return [];
    const t = schema.privacyRequests;
    const rows = await tx
      .select()
      .from(t)
      .where(
        and(
          inArray(
            t.brandId,
            brands.map((brand) => brand.id),
          ),
          principalId ? eq(t.principalId, principalId) : undefined,
        ),
      )
      .orderBy(desc(t.createdAt))
      .limit(100);
    return this.views(tx, rows);
  }

  private async views(tx: TenantTx, rows: RequestRow[]): Promise<PrivacyRequest[]> {
    if (rows.length === 0) return [];
    const brands = await tx
      .select({ id: schema.brands.id, name: schema.brands.name })
      .from(schema.brands)
      .where(inArray(schema.brands.id, [...new Set(rows.map((row) => row.brandId))]));
    const staffIds = [
      ...new Set(rows.flatMap((row) => (row.requestedBy ? [row.requestedBy] : []))),
    ];
    const staff = staffIds.length
      ? await tx
          .select({ id: schema.staffMembers.id, name: schema.staffMembers.displayName })
          .from(schema.staffMembers)
          .where(inArray(schema.staffMembers.id, staffIds))
      : [];
    const files = await tx
      .select({
        requestId: schema.privacyFiles.requestId,
        byteSize: schema.privacyFiles.byteSize,
        purgeAfter: schema.privacyFiles.purgeAfter,
        kept: sql<boolean>`${schema.privacyFiles.raw} is not null`,
      })
      .from(schema.privacyFiles)
      .where(
        inArray(
          schema.privacyFiles.requestId,
          rows.map((row) => row.id),
        ),
      );
    const brandName = new Map(brands.map((brand) => [brand.id, brand.name]));
    const staffName = new Map(staff.map((member) => [member.id, member.name]));
    const fileOf = new Map(files.map((file) => [file.requestId, file]));
    const now = this.clock();
    return rows.map((row) => {
      const file = fileOf.get(row.id);
      return {
        id: toPublicId('privacyRequest', row.id),
        kind: row.kind,
        customerId: toPublicId('customer', row.principalId),
        brand: { id: toPublicId('brand', row.brandId), name: brandName.get(row.brandId) ?? '' },
        state: row.state,
        reason: row.reason,
        reference: row.reference,
        requestedBy: row.requestedBy
          ? {
              id: toPublicId('staff', row.requestedBy),
              name: staffName.get(row.requestedBy) ?? '',
            }
          : null,
        counts: row.counts,
        problem: row.problem,
        file:
          file?.kept && file.purgeAfter > now
            ? { byteSize: file.byteSize, expiresAt: file.purgeAfter.toISOString() }
            : null,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      };
    });
  }

  list(principal: StaffPrincipal): Promise<{ items: PrivacyRequest[] }> {
    return this.tx(principal, async (tx) => ({
      items: await this.requestRows(tx, await this.brandsFor(tx, principal)),
    }));
  }

  private async requestRow(tx: TenantTx, requestId: string) {
    const [row] = await tx
      .select({ request: schema.privacyRequests, brand: schema.brands })
      .from(schema.privacyRequests)
      .innerJoin(schema.brands, eq(schema.brands.id, schema.privacyRequests.brandId))
      .where(eq(schema.privacyRequests.id, internalId('privacyRequest', requestId)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Request not found.' });
    return row;
  }

  get(principal: StaffPrincipal, requestId: string): Promise<PrivacyRequest> {
    return this.tx(principal, async (tx) => {
      const { request, brand } = await this.requestRow(tx, requestId);
      enforce(this.either(principal, brand) as Parameters<typeof enforce>[0]);
      return (await this.views(tx, [request]))[0] as PrivacyRequest;
    });
  }

  /** An export's ZIP while it is kept (24 hours); each download is audited. */
  file(principal: StaffPrincipal, requestId: string): Promise<{ bytes: Buffer; name: string }> {
    return this.tx(principal, async (tx) => {
      const { request, brand } = await this.requestRow(tx, requestId);
      enforce(this.allowed(principal, 'customers.export', brand));
      const [file] = await tx
        .select()
        .from(schema.privacyFiles)
        .where(eq(schema.privacyFiles.requestId, request.id));
      if (request.kind !== 'export' || !file?.raw || file.purgeAfter <= this.clock()) {
        throw new AppError('NOT_FOUND', {
          detail: 'There is no file to download: exports are kept for 24 hours.',
        });
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'privacy.export_downloaded',
        targetType: 'customer',
        targetId: toPublicId('customer', request.principalId),
        outcome: 'success',
        data: { requestId, sha256: file.sha256, bytes: file.byteSize },
        occurredAt: this.clock(),
      });
      return {
        bytes: file.raw,
        name: `customer-${toPublicId('customer', request.principalId)}.zip`,
      };
    });
  }
}
