import type * as C from '@hamnivo/contracts';
import type { z } from 'zod';
import { ApiError, api } from './api';
import { API_BASE } from './config';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

/** API shapes of reports and billing (board 23), at type level only. */
export type AnalyticsOverview = C.AnalyticsOverview;
export type UsageOverview = z.infer<typeof C.UsageOverview>;
export type UsageMeter = z.infer<typeof C.UsageMeter>;
export type BillingOverview = z.infer<typeof C.BillingOverview>;
export type Budget = z.infer<typeof C.Budget>;
export type InvoiceSummary = z.infer<typeof C.InvoiceSummary>;
export type Invoice = z.infer<typeof C.Invoice>;

type Tickets = AnalyticsOverview['tickets'];

/** Ticket priorities, highest first (H19). */
export const TICKET_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
/** Where tickets come from, in the order the report lists them. */
export const TICKET_SOURCES = ['offline_form', 'staff', 'automation'] as const;

/** Tickets by priority, highest first, then those with none. */
export function ticketsByPriority(tickets: Tickets): Tickets['byPriority'] {
  const rank = (priority: Tickets['byPriority'][number]['priority']) =>
    priority === null ? TICKET_PRIORITIES.length : TICKET_PRIORITIES.indexOf(priority);
  return [...tickets.byPriority].sort((a, b) => rank(a.priority) - rank(b.priority));
}

/** Tickets by source: the contact form, staff, then automations. */
export function ticketsBySource(tickets: Tickets): Tickets['bySource'] {
  const rank = (source: string) => {
    const at = (TICKET_SOURCES as readonly string[]).indexOf(source);
    return at < 0 ? TICKET_SOURCES.length : at;
  };
  return [...tickets.bySource].sort((a, b) => rank(a.source) - rank(b.source));
}

/**
 * Nothing to show on the Tickets tab: none opened or closed in the range and none open now. A
 * withheld count (null) is not nothing.
 */
export const noTickets = (overview: Pick<AnalyticsOverview, 'tickets'>) =>
  [overview.tickets.created, overview.tickets.closed, overview.tickets.openNow].every(
    (metric) => metric.value === 0,
  );

export interface ReportFilters {
  from: string;
  to: string;
  timezone: string;
  teamId?: string | undefined;
  channel?: string | undefined;
}

export const reportKeys = {
  analytics: (filters: ReportFilters) => ['reports', 'analytics', filters],
  billing: ['billing'],
  invoice: (id: string) => ['billing', 'invoices', id],
} as const;

export function analyticsQueryString(filters: ReportFilters): string {
  const params = new URLSearchParams({
    from: filters.from,
    to: filters.to,
    timezone: filters.timezone,
  });
  if (filters.teamId) params.set('teamId', filters.teamId);
  if (filters.channel) params.set('channel', filters.channel);
  return params.toString();
}

export function useAnalytics(filters: ReportFilters) {
  const { can } = useTenant();
  return useStudioQuery<AnalyticsOverview>(
    reportKeys.analytics(filters),
    `/v1/admin/analytics/overview?${analyticsQueryString(filters)}`,
    { enabled: can('analytics.read') },
  );
}

export function useBilling() {
  const { can } = useTenant();
  return useStudioQuery<BillingOverview>(reportKeys.billing, '/v1/admin/billing', {
    enabled: can('billing.read'),
  });
}

export function useInvoice(id: string | null) {
  const { can } = useTenant();
  return useStudioQuery<Invoice>(
    reportKeys.invoice(id ?? ''),
    `/v1/admin/billing/invoices/${encodeURIComponent(id ?? '')}`,
    { enabled: can('billing.read') && id !== null },
  );
}

export function useSetBudget() {
  return useStudioMutation(
    (body: { aiTokens: number | null; alertThresholds: number[] }, tenant) =>
      api<Budget>('/v1/admin/billing/budget', { method: 'PUT', tenant, body }),
    [reportKeys.billing],
  );
}

/** Downloads the report as CSV through the session (the export route answers text/csv). */
export async function downloadCsv(filters: ReportFilters, tenantId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE}/v1/admin/analytics/export?${analyticsQueryString(filters)}`,
    { credentials: 'include', headers: { 'x-hamnivo-tenant': tenantId } },
  );
  if (!response.ok) {
    let problem: C.Problem | null = null;
    try {
      problem = (await response.json()) as C.Problem;
    } catch {
      problem = null;
    }
    throw new ApiError(response.status, problem?.code ?? 'UNKNOWN', problem);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `hamnivo-report-${filters.from}-${filters.to}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type { Items };
