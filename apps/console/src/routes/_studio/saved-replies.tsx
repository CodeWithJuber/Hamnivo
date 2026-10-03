import { createFileRoute } from '@tanstack/react-router';
import { LibraryPage } from '../../pages/library/LibraryPage';

export interface LibrarySearch {
  brand?: string;
}

export const Route = createFileRoute('/_studio/saved-replies')({
  validateSearch: (search: Record<string, unknown>): LibrarySearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand } : {},
  component: LibraryRoute,
});

function LibraryRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <LibraryPage
      requested={search.brand}
      onBrand={(brand) => void navigate({ search: { brand } })}
    />
  );
}
