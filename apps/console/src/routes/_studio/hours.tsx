import { createFileRoute } from '@tanstack/react-router';
import { HoursPage } from '../../pages/settings/HoursPage';

export interface BrandSearch {
  brand?: string;
}

export const Route = createFileRoute('/_studio/hours')({
  validateSearch: (search: Record<string, unknown>): BrandSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: HoursPage,
});
