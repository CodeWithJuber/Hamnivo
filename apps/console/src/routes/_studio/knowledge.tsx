import { createFileRoute } from '@tanstack/react-router';
import { KnowledgePage } from '../../pages/KnowledgePage';

export interface KnowledgeSearch {
  source?: string;
  document?: string;
}

export const Route = createFileRoute('/_studio/knowledge')({
  validateSearch: (search: Record<string, unknown>): KnowledgeSearch => ({
    ...(typeof search.source === 'string' ? { source: search.source } : {}),
    ...(typeof search.document === 'string' ? { document: search.document } : {}),
  }),
  component: KnowledgePage,
});
