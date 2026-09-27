import { createFileRoute } from '@tanstack/react-router';
import { MemoryPage } from '../../../pages/MemoryPage';

export interface MemorySearch {
  q?: string;
  brand?: string;
}

export const Route = createFileRoute('/_studio/memory/')({
  validateSearch: (search: Record<string, unknown>): MemorySearch => ({
    ...(typeof search.q === 'string' && search.q ? { q: search.q } : {}),
    ...(typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {}),
  }),
  component: MemoryPage,
});
