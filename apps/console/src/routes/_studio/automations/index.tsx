import { createFileRoute } from '@tanstack/react-router';
import { AutomationsPage } from '../../../pages/automations/AutomationsPage';

export interface AutomationsSearch {
  /** brd_… */
  brand?: string;
}

export const Route = createFileRoute('/_studio/automations/')({
  validateSearch: (search: Record<string, unknown>): AutomationsSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand.slice(0, 64) } : {},
  component: AutomationsPage,
});
