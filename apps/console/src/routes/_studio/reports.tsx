import { createFileRoute } from '@tanstack/react-router';
import { ReportsPage } from '../../pages/reports/ReportsPage';

export type ReportsTab = 'quality' | 'teams' | 'ai' | 'billing';
export type ReportRange = '7d' | '30d' | '90d' | 'custom';

export interface ReportsSearch {
  tab?: ReportsTab;
  /** Last 7, 30 or 90 days, or `custom` with from and to. */
  range?: ReportRange;
  from?: string;
  to?: string;
  /** team_… */
  team?: string;
  /** The authority inbox's channel type, e.g. `Channel::Api`. */
  channelType?: string;
}

const TABS: readonly ReportsTab[] = ['quality', 'teams', 'ai', 'billing'];
const RANGES: readonly ReportRange[] = ['7d', '30d', '90d', 'custom'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

export const Route = createFileRoute('/_studio/reports')({
  validateSearch: (search: Record<string, unknown>): ReportsSearch => {
    const range = typeof search.range === 'string' ? search.range : '';
    const from = text(search.from);
    const to = text(search.to);
    const team = text(search.team);
    const channelType = text(search.channelType);
    return {
      ...(TABS.includes(search.tab as ReportsTab) ? { tab: search.tab as ReportsTab } : {}),
      ...(RANGES.includes(range as ReportRange) ? { range: range as ReportRange } : {}),
      ...(from && DATE.test(from) ? { from } : {}),
      ...(to && DATE.test(to) ? { to } : {}),
      ...(team ? { team } : {}),
      ...(channelType ? { channelType } : {}),
    };
  },
  component: ReportsPage,
});
