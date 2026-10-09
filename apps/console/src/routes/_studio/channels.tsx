import { createFileRoute } from '@tanstack/react-router';
import { ChannelsPage } from '../../pages/channels/ChannelsPage';

export interface ChannelsSearch {
  /** brd_… */
  brand?: string;
}

export const Route = createFileRoute('/_studio/channels')({
  validateSearch: (search: Record<string, unknown>): ChannelsSearch =>
    typeof search.brand === 'string' && search.brand ? { brand: search.brand.slice(0, 64) } : {},
  component: ChannelsPage,
});
