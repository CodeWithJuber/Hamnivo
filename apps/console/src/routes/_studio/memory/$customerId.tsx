import { createFileRoute } from '@tanstack/react-router';
import { CustomerMemoryPage } from '../../../pages/CustomerMemoryPage';

export type MemoryTab = 'preferences' | 'facts' | 'notes';

export interface CustomerMemorySearch {
  tab?: MemoryTab;
  memory?: string;
}

const TABS: readonly MemoryTab[] = ['preferences', 'facts', 'notes'];

export const Route = createFileRoute('/_studio/memory/$customerId')({
  validateSearch: (search: Record<string, unknown>): CustomerMemorySearch => ({
    ...(TABS.includes(search.tab as MemoryTab) ? { tab: search.tab as MemoryTab } : {}),
    ...(typeof search.memory === 'string' && search.memory ? { memory: search.memory } : {}),
  }),
  component: CustomerMemoryPage,
});
