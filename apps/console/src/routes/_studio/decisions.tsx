import { createFileRoute } from '@tanstack/react-router';
import { DecisionsPage } from '../../pages/DecisionsPage';

export interface BrandSearch {
  brand?: string;
}

export const Route = createFileRoute('/_studio/decisions')({
  validateSearch: (search: Record<string, unknown>): BrandSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: DecisionsPage,
});
