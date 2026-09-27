import { createHash } from 'node:crypto';
import {
  type AddDocumentRequest,
  type AddDocumentVersionRequest,
  type CreateKnowledgeSourceRequest,
  KNOWLEDGE_MAX_BYTES,
  type KnowledgeDocument,
  type KnowledgeMediaType,
  type KnowledgePassage,
  type KnowledgeSearchRequest,
  type KnowledgeSource,
  type UpdateKnowledgeSourceRequest,
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
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { RetrievalService } from './retrieval.service.js';

type SourceRow = typeof schema.knowledgeSources.$inferSelect;
type DocumentRow = typeof schema.knowledgeDocuments.$inferSelect;
type VersionRow = typeof schema.documentVersions.$inferSelect;
type Content = z.output<typeof AddDocumentVersionRequest>['content'];

const DAY_MS = 86_400_000;

/** Whether a document may ground answers now, shown next to citations (G06). */
export function freshnessOf(
  source: Pick<SourceRow, 'reviewEveryDays'>,
  document: Pick<DocumentRow, 'reviewedAt'>,
  version: Pick<VersionRow, 'validUntil' | 'readyAt'> | undefined,
  now: Date,
): 'current' | 'stale' | 'expired' {
  if (version?.validUntil && version.validUntil <= now) return 'expired';
  const checked = document.reviewedAt ?? version?.readyAt ?? null;
  if (
    source.reviewEveryDays &&
    checked &&
    now.getTime() - checked.getTime() > source.reviewEveryDays * DAY_MS
  ) {
    return 'stale';
  }
  return 'current';
}

function sourceView(row: SourceRow, documentCount: number): KnowledgeSource {
  return {
    id: toPublicId('source', row.id),
    workspaceId: toPublicId('workspace', row.workspaceId),
    brandId: toPublicId('brand', row.brandId),
    name: row.name,
    visibility: row.visibility,
    status: row.status,
    owner: row.ownerStaffId ? toPublicId('staff', row.ownerStaffId) : null,
    reviewEveryDays: row.reviewEveryDays,
    documentCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function versionView(row: VersionRow, chunkCount: number) {
  return {
    version: row.version,
    state: row.state,
    mediaType: row.mediaType as z.infer<typeof KnowledgeMediaType>,
    byteSize: row.byteSize,
    chunkCount,
    error: row.error,
    validUntil: iso(row.validUntil),
    createdAt: row.createdAt.toISOString(),
    readyAt: iso(row.readyAt),
  };
}

/** Bytes of an upload: text as UTF-8, files from base64. */
function contentBytes(content: Content): Buffer {
  const bytes =
    content.base64 !== undefined
      ? Buffer.from(content.base64, 'base64')
      : Buffer.from(content.text ?? '', 'utf8');
  if (bytes.byteLength === 0) {
    throw new AppError('VALIDATION_FAILED', { detail: 'The document is empty.' });
  }
  if (bytes.byteLength > KNOWLEDGE_MAX_BYTES) {
    throw new AppError('UPLOAD_TOO_LARGE', { detail: 'Documents can be up to 5 MB.' });
  }
  return bytes;
}

/**
 * Knowledge administration (G04): sources with owners, visibility and review cycles; documents
 * whose versions are quarantined, scanned and indexed by the worker before answers use them.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly retrieval: RetrievalService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private allowed(
    principal: StaffPrincipal,
    permission: Permission,
    resource: { workspaceId: string; brandId: string },
  ) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    target: { type: string; id: string },
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: target.type,
      targetId: target.id,
      outcome: 'success',
      data,
    });
  }

  private async source(tx: TenantTx, publicId: string, lock = false): Promise<SourceRow> {
    const query = tx
      .select()
      .from(schema.knowledgeSources)
      .where(eq(schema.knowledgeSources.id, fromPublicId('source', publicId)));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Knowledge source not found.' });
    return row;
  }

  private async document(tx: TenantTx, publicId: string) {
    const [row] = await tx
      .select({ document: schema.knowledgeDocuments, source: schema.knowledgeSources })
      .from(schema.knowledgeDocuments)
      .innerJoin(
        schema.knowledgeSources,
        eq(schema.knowledgeSources.id, schema.knowledgeDocuments.sourceId),
      )
      .where(eq(schema.knowledgeDocuments.id, fromPublicId('document', publicId)));
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Document not found.' });
    return row;
  }

  private async documentViews(
    tx: TenantTx,
    source: SourceRow,
    documents: DocumentRow[],
  ): Promise<KnowledgeDocument[]> {
    if (documents.length === 0) return [];
    const ids = documents.map((d) => d.id);
    const versions = await tx
      .select()
      .from(schema.documentVersions)
      .where(inArray(schema.documentVersions.documentId, ids))
      .orderBy(desc(schema.documentVersions.version));
    const counts = await tx
      .select({ versionId: schema.knowledgeChunks.versionId, n: count() })
      .from(schema.knowledgeChunks)
      .where(inArray(schema.knowledgeChunks.documentId, ids))
      .groupBy(schema.knowledgeChunks.versionId);
    const chunks = new Map(counts.map((c) => [c.versionId, Number(c.n)]));
    const now = this.clock();
    return documents.map((document) => {
      const own = versions.filter((v) => v.documentId === document.id);
      const current = own.find((v) => v.id === document.currentVersionId);
      const latest = own[0];
      return {
        id: toPublicId('document', document.id),
        sourceId: toPublicId('source', document.sourceId),
        title: document.title,
        url: document.url,
        language: document.language,
        status: document.status,
        current: current ? versionView(current, chunks.get(current.id) ?? 0) : null,
        latest:
          latest && latest.id !== current?.id
            ? versionView(latest, chunks.get(latest.id) ?? 0)
            : null,
        reviewedAt: iso(document.reviewedAt),
        freshness: freshnessOf(source, document, current, now),
        createdAt: document.createdAt.toISOString(),
      };
    });
  }

  async listSources(principal: StaffPrincipal): Promise<KnowledgeSource[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.knowledgeSources)
        .orderBy(asc(schema.knowledgeSources.createdAt));
      const counts = await tx
        .select({ sourceId: schema.knowledgeDocuments.sourceId, n: count() })
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.status, 'active'))
        .groupBy(schema.knowledgeDocuments.sourceId);
      const byId = new Map(counts.map((c) => [c.sourceId, Number(c.n)]));
      return rows
        .filter((row) => this.allowed(principal, 'knowledge.read', row).allowed)
        .map((row) => sourceView(row, byId.get(row.id) ?? 0));
    });
  }

  async createSource(
    principal: StaffPrincipal,
    input: z.output<typeof CreateKnowledgeSourceRequest>,
  ): Promise<KnowledgeSource> {
    const brandId = fromPublicId('brand', input.brandId);
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'knowledge.manage', { workspaceId: brand.workspaceId, brandId }),
      );
      const [row] = await tx
        .insert(schema.knowledgeSources)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          name: input.name,
          visibility: input.visibility,
          reviewEveryDays: input.reviewEveryDays ?? null,
          ownerStaffId: principal.staffMemberId,
        })
        .returning();
      if (!row) throw new Error('source insert returned nothing');
      await this.audit(
        tx,
        principal,
        'knowledge.source_created',
        {
          type: 'knowledge_source',
          id: toPublicId('source', row.id),
        },
        { name: row.name, visibility: row.visibility },
      );
      return sourceView(row, 0);
    });
  }

  async updateSource(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateKnowledgeSourceRequest>,
  ): Promise<KnowledgeSource> {
    return this.tx(principal, async (tx) => {
      const row = await this.source(tx, publicId, true);
      enforce(this.allowed(principal, 'knowledge.manage', row));
      const [updated] = await tx
        .update(schema.knowledgeSources)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.reviewEveryDays !== undefined
            ? { reviewEveryDays: input.reviewEveryDays }
            : {}),
          updatedAt: this.clock(),
        })
        .where(eq(schema.knowledgeSources.id, row.id))
        .returning();
      if (!updated) throw new Error('source update returned nothing');
      await this.audit(
        tx,
        principal,
        'knowledge.source_updated',
        {
          type: 'knowledge_source',
          id: publicId,
        },
        { ...input },
      );
      const [documents] = await tx
        .select({ n: count() })
        .from(schema.knowledgeDocuments)
        .where(
          and(
            eq(schema.knowledgeDocuments.sourceId, row.id),
            eq(schema.knowledgeDocuments.status, 'active'),
          ),
        );
      return sourceView(updated, Number(documents?.n ?? 0));
    });
  }

  async listDocuments(principal: StaffPrincipal, sourceId: string): Promise<KnowledgeDocument[]> {
    return this.tx(principal, async (tx) => {
      const source = await this.source(tx, sourceId);
      enforce(this.allowed(principal, 'knowledge.read', source));
      const documents = await tx
        .select()
        .from(schema.knowledgeDocuments)
        .where(eq(schema.knowledgeDocuments.sourceId, source.id))
        .orderBy(asc(schema.knowledgeDocuments.createdAt));
      return this.documentViews(tx, source, documents);
    });
  }

  async getDocument(principal: StaffPrincipal, publicId: string): Promise<KnowledgeDocument> {
    return this.tx(principal, async (tx) => {
      const { document, source } = await this.document(tx, publicId);
      enforce(this.allowed(principal, 'knowledge.read', source));
      const [view] = await this.documentViews(tx, source, [document]);
      if (!view) throw new Error('document view missing');
      return view;
    });
  }

  /** Stores the upload in quarantine and queues ingestion. */
  private async queueVersion(
    tx: TenantTx,
    principal: StaffPrincipal,
    document: DocumentRow,
    content: Content,
  ): Promise<VersionRow> {
    const bytes = contentBytes(content);
    const [latest] = await tx
      .select({ version: schema.documentVersions.version })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, document.id))
      .orderBy(desc(schema.documentVersions.version))
      .limit(1);
    const [version] = await tx
      .insert(schema.documentVersions)
      .values({
        tenantId: principal.tenantId,
        documentId: document.id,
        version: (latest?.version ?? 0) + 1,
        mediaType: content.mediaType,
        byteSize: bytes.byteLength,
        contentHash: createHash('sha256').update(bytes).digest(),
        raw: bytes,
        validUntil: content.validUntil ? new Date(content.validUntil) : null,
        createdBy: principal.staffMemberId,
      })
      .returning();
    if (!version) throw new Error('version insert returned nothing');
    await enqueueOutbox(tx, principal.tenantId, {
      topic: 'knowledge.ingest',
      aggregateType: 'document_version',
      aggregateId: version.id,
      payload: { versionId: version.id },
    });
    return version;
  }

  async addDocument(
    principal: StaffPrincipal,
    sourceId: string,
    input: z.output<typeof AddDocumentRequest>,
  ): Promise<KnowledgeDocument> {
    return this.tx(principal, async (tx) => {
      const source = await this.source(tx, sourceId);
      enforce(this.allowed(principal, 'knowledge.manage', source));
      if (source.status === 'retired') {
        throw new AppError('VALIDATION_FAILED', { detail: 'This source is retired.' });
      }
      const [document] = await tx
        .insert(schema.knowledgeDocuments)
        .values({
          tenantId: principal.tenantId,
          sourceId: source.id,
          title: input.title,
          url: input.url ?? null,
          language: input.language ?? null,
        })
        .returning();
      if (!document) throw new Error('document insert returned nothing');
      const version = await this.queueVersion(tx, principal, document, input.content);
      await this.audit(
        tx,
        principal,
        'knowledge.document_added',
        {
          type: 'knowledge_document',
          id: toPublicId('document', document.id),
        },
        { title: document.title, mediaType: version.mediaType, bytes: version.byteSize },
      );
      const [view] = await this.documentViews(tx, source, [document]);
      if (!view) throw new Error('document view missing');
      return view;
    });
  }

  async addVersion(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof AddDocumentVersionRequest>,
  ): Promise<KnowledgeDocument> {
    return this.tx(principal, async (tx) => {
      const { document, source } = await this.document(tx, publicId);
      enforce(this.allowed(principal, 'knowledge.manage', source));
      if (document.status !== 'active') {
        throw new AppError('VALIDATION_FAILED', { detail: 'This document is retired.' });
      }
      const version = await this.queueVersion(tx, principal, document, input.content);
      await this.audit(
        tx,
        principal,
        'knowledge.version_added',
        {
          type: 'knowledge_document',
          id: publicId,
        },
        { version: version.version, mediaType: version.mediaType, bytes: version.byteSize },
      );
      const [view] = await this.documentViews(tx, source, [document]);
      if (!view) throw new Error('document view missing');
      return view;
    });
  }

  private async setDocument(
    principal: StaffPrincipal,
    publicId: string,
    change: Partial<Pick<DocumentRow, 'status' | 'reviewedAt'>>,
    action: string,
  ): Promise<KnowledgeDocument> {
    return this.tx(principal, async (tx) => {
      const { document, source } = await this.document(tx, publicId);
      enforce(this.allowed(principal, 'knowledge.manage', source));
      const [updated] = await tx
        .update(schema.knowledgeDocuments)
        .set({ ...change, updatedAt: this.clock() })
        .where(eq(schema.knowledgeDocuments.id, document.id))
        .returning();
      await this.audit(tx, principal, action, { type: 'knowledge_document', id: publicId }, {});
      const [view] = await this.documentViews(tx, source, [updated ?? document]);
      if (!view) throw new Error('document view missing');
      return view;
    });
  }

  review(principal: StaffPrincipal, publicId: string) {
    return this.setDocument(
      principal,
      publicId,
      { reviewedAt: this.clock() },
      'knowledge.reviewed',
    );
  }

  retire(principal: StaffPrincipal, publicId: string) {
    return this.setDocument(principal, publicId, { status: 'retired' }, 'knowledge.retired');
  }

  async search(
    principal: StaffPrincipal,
    input: z.output<typeof KnowledgeSearchRequest>,
  ): Promise<KnowledgePassage[]> {
    const brandId = fromPublicId('brand', input.brandId);
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'knowledge.read', { workspaceId: brand.workspaceId, brandId }),
      );
      const passages = await this.retrieval.search(tx, {
        brandId,
        ...(input.sourceIds
          ? { sourceIds: input.sourceIds.map((id) => fromPublicId('source', id)) }
          : {}),
        audience: input.audience,
        query: input.query,
        limit: input.limit,
      });
      return passages.map((p) => ({
        documentId: toPublicId('document', p.documentId),
        sourceId: toPublicId('source', p.sourceId),
        title: p.title,
        url: p.url,
        heading: p.heading,
        text: p.text,
        version: p.version,
        score: p.score,
      }));
    });
  }
}
