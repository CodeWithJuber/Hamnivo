import { createFileRoute } from '@tanstack/react-router';
import { DeveloperPage } from '../../pages/developer/DeveloperPage';

export type DeveloperTab = 'keys' | 'webhooks' | 'events' | 'hosts';

export interface DeveloperSearch {
  tab?: DeveloperTab;
  /** The webhook endpoint open in the side panel (whe_…). */
  endpoint?: string;
  /** The delivery shown in it (whd_…). */
  delivery?: string;
}

const TABS: readonly DeveloperTab[] = ['keys', 'webhooks', 'events', 'hosts'];
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_studio/developer')({
  validateSearch: (search: Record<string, unknown>): DeveloperSearch => {
    const endpoint = text(search.endpoint);
    const delivery = text(search.delivery);
    return {
      ...(TABS.includes(search.tab as DeveloperTab) ? { tab: search.tab as DeveloperTab } : {}),
      ...(endpoint ? { endpoint } : {}),
      ...(delivery ? { delivery } : {}),
    };
  },
  component: DeveloperPage,
});
