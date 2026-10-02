import { createFileRoute } from '@tanstack/react-router';
import { ChecksPage } from '../../pages/ChecksPage';

export interface BrandSearch {
  brand?: string;
}

export const Route = createFileRoute('/_studio/checks')({
  validateSearch: (search: Record<string, unknown>): BrandSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: ChecksPage,
});
