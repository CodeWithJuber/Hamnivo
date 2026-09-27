import { z } from 'zod';
import { LanguageTag, Timestamp } from './common.js';
import { typeId } from './ids.js';

/** `public`: may ground answers to customers. `internal`: staff and assist mode only. */
export const KnowledgeVisibility = z.enum(['public', 'internal']);

/** An approved knowledge source with an owner and a review cycle (G04). */
export const KnowledgeSource = z
  .object({
    id: typeId('source'),
    workspaceId: typeId('workspace'),
    brandId: typeId('brand'),
    name: z.string(),
    visibility: KnowledgeVisibility,
    status: z.enum(['active', 'paused', 'retired']),
    owner: typeId('staff').nullable(),
    /** Documents not reviewed within this many days stop grounding answers until reviewed. */
    reviewEveryDays: z.int().positive().nullable(),
    documentCount: z.int().nonnegative(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'KnowledgeSource' });
export type KnowledgeSource = z.infer<typeof KnowledgeSource>;

export const CreateKnowledgeSourceRequest = z
  .object({
    brandId: typeId('brand'),
    name: z.string().trim().min(1).max(120),
    visibility: KnowledgeVisibility.default('public'),
    reviewEveryDays: z.int().min(1).max(3650).optional(),
  })
  .meta({ id: 'CreateKnowledgeSourceRequest' });

export const UpdateKnowledgeSourceRequest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    visibility: KnowledgeVisibility.optional(),
    status: z.enum(['active', 'paused', 'retired']).optional(),
    reviewEveryDays: z.int().min(1).max(3650).nullable().optional(),
  })
  .meta({ id: 'UpdateKnowledgeSourceRequest' });

export const KNOWLEDGE_MEDIA_TYPES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const KnowledgeMediaType = z.enum(KNOWLEDGE_MEDIA_TYPES);

/** Largest upload accepted for a knowledge document. */
export const KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * A document's content: text, or the file as base64 (required for PDF and Word). Content is
 * quarantined, scanned and parsed before anything can use it (G17).
 */
export const DocumentContent = z
  .object({
    mediaType: KnowledgeMediaType,
    text: z.string().max(2_000_000).optional(),
    base64: z
      .string()
      .max(Math.ceil((KNOWLEDGE_MAX_BYTES * 4) / 3) + 4)
      .optional(),
    /** Answers stop using this version after this time (for example, a seasonal policy). */
    validUntil: Timestamp.optional(),
  })
  .superRefine((value, ctx) => {
    const binary = value.mediaType === 'application/pdf' || value.mediaType.includes('openxml');
    if ((value.text === undefined) === (value.base64 === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'Send either text or base64' });
    } else if (binary && value.base64 === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['base64'],
        message: 'Send PDF and Word files as base64',
      });
    }
  });

export const AddDocumentRequest = z
  .object({
    title: z.string().trim().min(1).max(300),
    /** Where people can read the original; shown with citations. */
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .optional(),
    language: LanguageTag.optional(),
    content: DocumentContent,
  })
  .meta({ id: 'AddDocumentRequest' });

export const AddDocumentVersionRequest = z
  .object({ content: DocumentContent })
  .meta({ id: 'AddDocumentVersionRequest' });

export const DocumentVersionState = z.enum([
  'queued',
  'processing',
  'ready',
  'failed',
  'rejected',
  'superseded',
]);

export const DocumentVersion = z
  .object({
    version: z.int().positive(),
    state: DocumentVersionState,
    mediaType: KnowledgeMediaType,
    byteSize: z.int().nonnegative(),
    chunkCount: z.int().nonnegative(),
    /** Why ingestion failed or was refused, in plain words. */
    error: z.string().nullable(),
    validUntil: Timestamp.nullable(),
    createdAt: Timestamp,
    readyAt: Timestamp.nullable(),
  })
  .meta({ id: 'DocumentVersion' });

export const KnowledgeDocument = z
  .object({
    id: typeId('document'),
    sourceId: typeId('source'),
    title: z.string(),
    url: z.string().nullable(),
    language: z.string().nullable(),
    status: z.enum(['active', 'retired']),
    /** The version answers use; null until the first version is ready. */
    current: DocumentVersion.nullable(),
    /** The newest version, when it is still being processed or was refused. */
    latest: DocumentVersion.nullable(),
    reviewedAt: Timestamp.nullable(),
    freshness: z.enum(['current', 'stale', 'expired']),
    createdAt: Timestamp,
  })
  .meta({ id: 'KnowledgeDocument' });
export type KnowledgeDocument = z.infer<typeof KnowledgeDocument>;

export const KnowledgeSearchRequest = z
  .object({
    query: z.string().trim().min(1).max(1000),
    brandId: typeId('brand'),
    sourceIds: z.array(typeId('source')).max(50).optional(),
    /** `customer` searches only what may ground customer answers. */
    audience: z.enum(['customer', 'staff']).default('customer'),
    limit: z.int().min(1).max(20).default(5),
  })
  .meta({ id: 'KnowledgeSearchRequest' });

export const KnowledgePassage = z
  .object({
    documentId: typeId('document'),
    sourceId: typeId('source'),
    title: z.string(),
    url: z.string().nullable(),
    heading: z.string().nullable(),
    text: z.string(),
    version: z.int().positive(),
    score: z.number(),
  })
  .meta({ id: 'KnowledgePassage' });
export type KnowledgePassage = z.infer<typeof KnowledgePassage>;
