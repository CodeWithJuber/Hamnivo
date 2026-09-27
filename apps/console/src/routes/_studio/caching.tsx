import { createFileRoute } from '@tanstack/react-router';
import { CachingPage } from '../../pages/CachingPage';
import type { BrandSearch } from './decisions';

export const Route = createFileRoute('/_studio/caching')({
  validateSearch: (search: Record<string, unknown>): BrandSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: CachingPage,
});
