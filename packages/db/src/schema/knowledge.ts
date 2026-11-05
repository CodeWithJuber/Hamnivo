import { sql } from 'drizzle-orm';
import {
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { bytea, createdAt, id, tenantIsolation, tstz, updatedAt } from './helpers.js';
import { staffMembers } from './identity.js';
import { brands, tenantId, workspaces } from './tenancy.js';

/** Dimensions of stored embeddings; changing it means re-embedding every chunk. */
export const EMBEDDING_DIMENSIONS = 768;

const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/**
 * An approved knowledge source (G04): who owns it, whether customers may see answers drawn from
 * it, and how often it must be reviewed.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: uuid('workspace_id').notNull(),
    brandId: uuid('brand_id').notNull(),
    name: text('name').notNull(),
    /** `public`: may ground customer answers and AI drafts. `internal`: staff search only. */
    visibility: text('visibility', { enum: ['public', 'internal'] })
      .notNull()
      .default('public'),
    status: text('status', { enum: ['active', 'paused', 'retired'] })
      .notNull()
      .default('active'),
    ownerStaffId: uuid('owner_staff_id'),
    /** Documents not reviewed within this many days stop grounding answers. */
    reviewEveryDays: integer('review_every_days'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('knowledge_sources_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'knowledge_sources_workspace_fk',
      columns: [t.tenantId, t.workspaceId],
      foreignColumns: [workspaces.tenantId, workspaces.id],
    }),
    foreignKey({
      name: 'knowledge_sources_brand_fk',
      columns: [t.tenantId, t.brandId],
      foreignColumns: [brands.tenantId, brands.id],
    }),
    foreignKey({
      name: 'knowledge_sources_owner_fk',
      columns: [t.tenantId, t.ownerStaffId],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    tenantIsolation(),
  ],
);

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid('source_id').notNull(),
    title: text('title').notNull(),
    url: text('url'),
    language: text('language'),
    currentVersionId: uuid('current_version_id'),
    status: text('status', { enum: ['active', 'retired'] })
      .notNull()
      .default('active'),
    reviewedAt: tstz('reviewed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('knowledge_documents_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'knowledge_documents_source_fk',
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
    foreignKey({
      name: 'knowledge_documents_current_version_fk',
      columns: [t.tenantId, t.currentVersionId],
      foreignColumns: [documentVersions.tenantId, documentVersions.id],
    }),
    tenantIsolation(),
  ],
);

/** One immutable text of a document; ingestion fills its chunks. */
export const documentVersions = pgTable(
  'document_versions',
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid('document_id').notNull(),
    version: integer('version').notNull(),
    state: text('state', {
      enum: ['queued', 'processing', 'ready', 'failed', 'rejected', 'superseded'],
    })
      .notNull()
      .default('queued'),
    mediaType: text('media_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    contentHash: bytea('content_hash').notNull(),
    /** Original upload until ingestion finishes; cleared afterwards (quarantine). */
    raw: bytea('raw'),
    /** Sanitized plain text the chunks come from. */
    text: text('text'),
    error: text('error'),
    progress: jsonb('progress').notNull().default({}),
    validUntil: tstz('valid_until'),
    createdBy: uuid('created_by'),
    createdAt: createdAt(),
    readyAt: tstz('ready_at'),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('document_versions_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('document_versions_version_key').on(t.tenantId, t.documentId, t.version),
    foreignKey({
      name: 'document_versions_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [staffMembers.tenantId, staffMembers.id],
    }),
    foreignKey({
      name: 'document_versions_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [knowledgeDocuments.tenantId, knowledgeDocuments.id],
    }),
    tenantIsolation(),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: id(),
    tenantId: tenantId(),
    versionId: uuid('version_id').notNull(),
    documentId: uuid('document_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    seq: integer('seq').notNull(),
    heading: text('heading'),
    text: text('text').notNull(),
    tokens: integer('tokens').notNull(),
    // 'simple' does no stemming, so Arabic, Urdu, Hindi and English all index word by word.
    search: tsvector('search').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("heading", '') || ' ' || "text")`,
    ),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text('embedding_model'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('knowledge_chunks_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('knowledge_chunks_seq_key').on(t.tenantId, t.versionId, t.seq),
    index('knowledge_chunks_search_idx').using('gin', t.search),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_source_idx').on(t.tenantId, t.sourceId),
    foreignKey({
      name: 'knowledge_chunks_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [documentVersions.tenantId, documentVersions.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'knowledge_chunks_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [knowledgeDocuments.tenantId, knowledgeDocuments.id],
    }),
    foreignKey({
      name: 'knowledge_chunks_source_fk',
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [knowledgeSources.tenantId, knowledgeSources.id],
    }),
    tenantIsolation(),
  ],
);
