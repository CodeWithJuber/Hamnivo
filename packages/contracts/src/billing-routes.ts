import { z } from 'zod';
import { AnalyticsOverview, AnalyticsQuery } from './analytics.js';
import {
  BillingOverview,
  Budget,
  Invoice,
  InvoiceSummary,
  SetBudgetRequest,
  UsageOverview,
} from './billing.js';
import type { RouteDef } from './routes.js';

/** Plan, usage, budget and invoices (board 23). Reads accept an API key with `billing.read`. */
export const billingRoutes = {
  getUsage: {
    method: 'get',
    path: '/v1/admin/usage',
    operationId: 'getUsage',
    summary:
      'Usage this period against the plan limits and budget, and whether AI replies are allowed (billing.read or tenant-wide analytics.read)',
    tags: ['Billing'],
    auth: 'staff_or_api_key',
    success: { status: 200, description: 'Usage', schema: UsageOverview },
  },
  getBilling: {
    method: 'get',
    path: '/v1/admin/billing',
    operationId: 'getBilling',
    summary: 'Plan, usage, budget and recent invoices (billing.read)',
    tags: ['Billing'],
    auth: 'staff_or_api_key',
    success: { status: 200, description: 'Billing', schema: BillingOverview },
  },
  setBudget: {
    method: 'put',
    path: '/v1/admin/billing/budget',
    operationId: 'setBudget',
    summary:
      'Set the AI token budget below the plan and the alert thresholds (billing.manage, fresh sign-in)',
    tags: ['Billing'],
    auth: 'staff_session',
    body: SetBudgetRequest,
    success: { status: 200, description: 'Budget', schema: Budget },
  },
  listInvoices: {
    method: 'get',
    path: '/v1/admin/billing/invoices',
    operationId: 'listInvoices',
    summary: 'Invoices, newest period first (billing.read)',
    tags: ['Billing'],
    auth: 'staff_or_api_key',
    success: {
      status: 200,
      description: 'Invoices',
      schema: z.object({ items: z.array(InvoiceSummary) }),
    },
  },
  getInvoice: {
    method: 'get',
    path: '/v1/admin/billing/invoices/{id}',
    operationId: 'getInvoice',
    summary: 'One invoice with its lines (billing.read)',
    tags: ['Billing'],
    auth: 'staff_or_api_key',
    params: z.object({ id: z.string().meta({ description: 'Invoice ID (invc_…)' }) }),
    success: { status: 200, description: 'Invoice', schema: Invoice },
  },
} as const satisfies Record<string, RouteDef>;

/** Product analytics (O04). Reads accept an API key with `analytics.read`. */
export const analyticsRoutes = {
  getAnalyticsOverview: {
    method: 'get',
    path: '/v1/admin/analytics/overview',
    operationId: 'getAnalyticsOverview',
    summary:
      'Service-quality aggregates for a date range, with small groups withheld (analytics.read)',
    tags: ['Analytics'],
    auth: 'staff_or_api_key',
    query: AnalyticsQuery,
    success: { status: 200, description: 'Overview', schema: AnalyticsOverview },
  },
  exportAnalytics: {
    method: 'get',
    path: '/v1/admin/analytics/export',
    operationId: 'exportAnalytics',
    summary: 'The same aggregates as CSV, with the same withholding (analytics.read)',
    tags: ['Analytics'],
    auth: 'staff_or_api_key',
    query: AnalyticsQuery,
    success: {
      status: 200,
      description: 'CSV report',
      schema: z.string(),
      contentType: 'text/csv',
    },
  },
} as const satisfies Record<string, RouteDef>;
