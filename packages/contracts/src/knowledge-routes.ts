import { z } from 'zod';
import {
  AddDocumentRequest,
  AddDocumentVersionRequest,
  CreateKnowledgeSourceRequest,
  KnowledgeDocument,
  KnowledgePassage,
  KnowledgeSearchRequest,
  KnowledgeSource,
  UpdateKnowledgeSourceRequest,
} from './knowledge.js';
import type { RouteDef } from './routes.js';

const sourceParams = z.object({
  sourceId: z.string().meta({ description: 'Knowledge source ID (ksrc_…)' }),
});
const documentParams = z.object({
  documentId: z.string().meta({ description: 'Document ID (doc_…)' }),
});

/** Knowledge sources, documents and retrieval (G04–G06, G17). */
export const knowledgeRoutes = {
  listKnowledgeSources: {
    method: 'get',
    path: '/v1/admin/knowledge/sources',
    operationId: 'listKnowledgeSources',
    summary: 'Knowledge sources of the tenant (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Sources',
      schema: z.object({ items: z.array(KnowledgeSource) }),
    },
  },
  createKnowledgeSource: {
    method: 'post',
    path: '/v1/admin/knowledge/sources',
    operationId: 'createKnowledgeSource',
    summary: 'Create a knowledge source for a brand (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    body: CreateKnowledgeSourceRequest,
    idempotent: true,
    success: { status: 201, description: 'Source created', schema: KnowledgeSource },
  },
  updateKnowledgeSource: {
    method: 'patch',
    path: '/v1/admin/knowledge/sources/{sourceId}',
    operationId: 'updateKnowledgeSource',
    summary: 'Rename, pause, retire or change who may see answers from a source (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: sourceParams,
    body: UpdateKnowledgeSourceRequest,
    success: { status: 200, description: 'Source', schema: KnowledgeSource },
  },
  listKnowledgeDocuments: {
    method: 'get',
    path: '/v1/admin/knowledge/sources/{sourceId}/documents',
    operationId: 'listKnowledgeDocuments',
    summary: 'Documents of a source with their ingestion state and freshness (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: sourceParams,
    success: {
      status: 200,
      description: 'Documents',
      schema: z.object({ items: z.array(KnowledgeDocument) }),
    },
  },
  addKnowledgeDocument: {
    method: 'post',
    path: '/v1/admin/knowledge/sources/{sourceId}/documents',
    operationId: 'addKnowledgeDocument',
    summary:
      'Add a document; it is scanned, parsed and indexed before answers can use it (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: sourceParams,
    body: AddDocumentRequest,
    idempotent: true,
    success: { status: 202, description: 'Queued for ingestion', schema: KnowledgeDocument },
  },
  getKnowledgeDocument: {
    method: 'get',
    path: '/v1/admin/knowledge/documents/{documentId}',
    operationId: 'getKnowledgeDocument',
    summary: 'A document with its current and latest version (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: documentParams,
    success: { status: 200, description: 'Document', schema: KnowledgeDocument },
  },
  addKnowledgeDocumentVersion: {
    method: 'post',
    path: '/v1/admin/knowledge/documents/{documentId}/versions',
    operationId: 'addKnowledgeDocumentVersion',
    summary:
      'Replace a document with a new version; the old one answers until the new one is ready (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: documentParams,
    body: AddDocumentVersionRequest,
    idempotent: true,
    success: { status: 202, description: 'Queued for ingestion', schema: KnowledgeDocument },
  },
  reviewKnowledgeDocument: {
    method: 'post',
    path: '/v1/admin/knowledge/documents/{documentId}/review',
    operationId: 'reviewKnowledgeDocument',
    summary: 'Confirm a document is still correct, restarting its review cycle (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: documentParams,
    success: { status: 200, description: 'Reviewed', schema: KnowledgeDocument },
  },
  retireKnowledgeDocument: {
    method: 'post',
    path: '/v1/admin/knowledge/documents/{documentId}/retire',
    operationId: 'retireKnowledgeDocument',
    summary: 'Stop using a document in answers (knowledge.manage)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    params: documentParams,
    success: { status: 200, description: 'Retired', schema: KnowledgeDocument },
  },
  searchKnowledge: {
    method: 'post',
    path: '/v1/admin/knowledge/search',
    operationId: 'searchKnowledge',
    summary: 'Preview which passages an answer would use (knowledge.read)',
    tags: ['Knowledge'],
    auth: 'staff_session',
    body: KnowledgeSearchRequest,
    success: {
      status: 200,
      description: 'Passages, best first',
      schema: z.object({ items: z.array(KnowledgePassage) }),
    },
  },
} as const satisfies Record<string, RouteDef>;
