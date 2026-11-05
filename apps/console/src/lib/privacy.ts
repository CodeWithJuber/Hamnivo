import type * as C from '@hamnivo/contracts';
import type { z } from 'zod';
import { api, newIdempotencyKey } from './api';
import { downloadFile } from './migration';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';

export type RetentionPolicy = z.infer<typeof C.RetentionPolicy>;
export type RetentionPreview = z.infer<typeof C.RetentionPreview>;
export type PrivacyCustomer = z.infer<typeof C.PrivacyCustomer>;
export type PrivacyCustomerSummary = z.infer<typeof C.PrivacyCustomerSummary>;
export type PrivacyRequest = z.infer<typeof C.PrivacyRequest>;
export type PrivacyReason = z.infer<typeof C.PrivacyReason>;

/** The select's value for keeping everything (the other values are days). */
export const KEEP_FOREVER = 'forever';

export const privacyKeys = {
  retention: ['privacy', 'retention'],
  preview: (days: number) => ['privacy', 'retention', 'preview', days],
  customers: (query: string) => ['privacy', 'customers', query],
  customer: (id: string) => ['privacy', 'customer', id],
  requests: ['privacy', 'requests'],
} as const;

/** How long the workspace keeps resolved conversations (A10); owners only. */
export function useRetention() {
  const { can } = useTenant();
  return useStudioQuery<RetentionPolicy>(privacyKeys.retention, '/v1/admin/privacy/retention', {
    enabled: can('privacy.manage'),
    // While old conversations are being deleted, the counts move.
    refetchInterval: (data) => (data?.sweep.state === 'running' ? 30_000 : false),
  });
}

/** What a period would delete today; nothing is asked for while keeping everything. */
export function useRetentionPreview(days: number | null) {
  const { can } = useTenant();
  return useStudioQuery<RetentionPreview>(
    privacyKeys.preview(days ?? 0),
    `/v1/admin/privacy/retention/preview?days=${days ?? 0}`,
    { enabled: can('privacy.manage') && days !== null },
  );
}

export function useSetRetention() {
  return useStudioMutation(
    (body: { conversationDays: number | null; version: number }, tenant) =>
      api<RetentionPolicy>('/v1/admin/privacy/retention', { method: 'PUT', tenant, body }),
    [privacyKeys.retention],
  );
}

/** The select's value for a policy, and the days for a select value. */
export const choiceOf = (days: number | null) => (days === null ? KEEP_FOREVER : String(days));
export const daysOf = (choice: string) => (choice === KEEP_FOREVER ? null : Number(choice));

/** Whether saving `next` deletes something sooner than what is kept now (it then waits a week). */
export function deletesSooner(current: number | null, next: number | null): boolean {
  return next !== null && (current === null || next < current);
}

/** Whether the person may export or erase customers in at least one brand. */
export function useCustomerDataAccess() {
  const { can } = useTenant();
  return { export: can('customers.export'), erase: can('customers.erase') };
}

/** Customers whose name, email, ID, phone or handle matches; nothing is asked for under 2 letters. */
export function usePrivacyCustomers(query: string) {
  const access = useCustomerDataAccess();
  const term = query.trim();
  return useStudioQuery<{ items: PrivacyCustomer[] }>(
    privacyKeys.customers(term),
    `/v1/admin/privacy/customers?query=${encodeURIComponent(term)}`,
    { enabled: (access.export || access.erase) && term.length >= 2 },
  );
}

/** What exporting or erasing one customer covers. */
export function usePrivacyCustomer(id: string | null) {
  return useStudioQuery<PrivacyCustomerSummary>(
    privacyKeys.customer(id ?? ''),
    `/v1/admin/privacy/customers/${id ?? ''}`,
    {
      enabled: id !== null,
      refetchInterval: (data) => (data?.requests.some(isWorking) ? 5_000 : false),
    },
  );
}

/** Exports and erasures, newest first; refreshed while one is still working. */
export function usePrivacyRequests() {
  const access = useCustomerDataAccess();
  return useStudioQuery<{ items: PrivacyRequest[] }>(
    privacyKeys.requests,
    '/v1/admin/privacy/requests',
    {
      enabled: access.export || access.erase,
      refetchInterval: (data) => (data?.items.some(isWorking) ? 5_000 : false),
    },
  );
}

export const isWorking = (request: Pick<PrivacyRequest, 'state'>) =>
  request.state === 'queued' || request.state === 'running';

export function useExportCustomer(customerId: string) {
  return useStudioMutation(
    (body: { reason: PrivacyReason; reference?: string }, tenant) =>
      api<PrivacyRequest>(`/v1/admin/privacy/customers/${customerId}/export`, {
        method: 'POST',
        tenant,
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    [privacyKeys.requests, privacyKeys.customer(customerId)],
  );
}

export function useEraseCustomer(customerId: string) {
  return useStudioMutation(
    (body: { confirm: string; reason: PrivacyReason; reference?: string }, tenant) =>
      api<PrivacyRequest>(`/v1/admin/privacy/customers/${customerId}/erase`, {
        method: 'POST',
        tenant,
        body,
        idempotencyKey: newIdempotencyKey(),
      }),
    [privacyKeys.requests, privacyKeys.customer(customerId)],
  );
}

/** Saves an export's ZIP; the gateway records each download. */
export function downloadExport(requestId: string, tenantId: string) {
  return downloadFile(
    `/v1/admin/privacy/requests/${requestId}/file`,
    tenantId,
    `customer-data-${requestId}.zip`,
  );
}
