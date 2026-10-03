import { createFileRoute } from '@tanstack/react-router';
import { IdentityPage } from '../../pages/settings/IdentityPage';

export interface BrandSearch {
  brand?: string;
}

export const Route = createFileRoute('/_studio/customer-identity')({
  validateSearch: (search: Record<string, unknown>): BrandSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: IdentityPage,
});
