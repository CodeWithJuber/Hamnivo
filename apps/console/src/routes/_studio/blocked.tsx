import { createFileRoute } from '@tanstack/react-router';
import type { BlockListStatus } from '../../lib/blocks';
import { BlockedPage } from '../../pages/visitors/BlockedPage';

export interface BlockedSearch {
  /** `active` (the default) or every block of the last 90 days. */
  status?: BlockListStatus;
  /** brand_… */
  brand?: string;
}

export const Route = createFileRoute('/_studio/blocked')({
  validateSearch: (search: Record<string, unknown>): BlockedSearch => ({
    ...(search.status === 'all' ? { status: 'all' } : {}),
    ...(typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {}),
  }),
  component: BlockedRoute,
});

function BlockedRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BlockedPage
      status={search.status ?? 'active'}
      brandId={search.brand ?? ''}
      onChange={(next) =>
        void navigate({
          search: (current: BlockedSearch) => {
            const merged = { ...current, ...next };
            return {
              ...(merged.status === 'all' ? { status: 'all' as const } : {}),
              ...(merged.brand ? { brand: merged.brand } : {}),
            };
          },
          replace: true,
        })
      }
    />
  );
}
