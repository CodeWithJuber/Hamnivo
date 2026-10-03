import type * as C from '@hamnivo/contracts';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, api, newIdempotencyKey } from './api';
import { platformKeys, usePlatformMutation } from './platform';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

/**
 * Running Hamnivo as a service (SaaS): the sign-up switch, Plan & billing, the automatic Chatwoot
 * set-up, and the platform console's plans, suspension and operator API keys. Types come from the
 * contracts at type level only.
 */
export type SignupSettings = z.infer<typeof C.SignupSettings>;
export type BillingSubscription = z.infer<typeof C.BillingSubscription>;
export type PlanOption = z.infer<typeof C.PlanOption>;
export type ProviderInvoice = z.infer<typeof C.ProviderInvoice>;
export type EmailSenderSettings = z.infer<typeof C.EmailSenderSettings>;
export type ProvisioningStatus = z.infer<typeof C.ProvisioningStatus>;
export type PlatformSignup = z.infer<typeof C.PlatformSignup>;
export type PlatformPlan = z.infer<typeof C.PlatformPlan>;
export type PlatformTenantBilling = z.infer<typeof C.PlatformTenantBilling>;
export type OperatorApiKey = z.infer<typeof C.OperatorApiKey>;
export type CreatedOperatorApiKey = z.infer<typeof C.CreatedOperatorApiKey>;

/** The finer reason of a refused request (`signup_closed`, `workspace_suspended`), if any. */
export function reasonOf(error: unknown): string | null {
  return error instanceof ApiError ? (error.problem?.reason ?? null) : null;
}

export const saasKeys = {
  signup: ['signup'],
  subscription: ['billing', 'subscription'],
  providerInvoices: ['billing', 'provider-invoices'],
  emailSender: ['email-sender'],
  provisioning: ['provisioning'],
} as const;

export const saasPlatformKeys = {
  signup: ['platform', 'signup'],
  plans: ['platform', 'plans'],
  tenantBilling: (id: string) => ['platform', 'tenant', id, 'billing'],
  operatorKeys: ['platform', 'operator-keys'],
} as const;

/** Whether public sign-up is open, and the Turnstile site key (no session needed). */
export function useSignupSettings() {
  return useQuery({
    queryKey: saasKeys.signup,
    queryFn: ({ signal }) => api<SignupSettings>('/v1/signup', { signal }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useSubscription() {
  const { can } = useTenant();
  return useStudioQuery<BillingSubscription>(
    saasKeys.subscription,
    '/v1/admin/billing/subscription',
    { enabled: can('billing.read') },
  );
}

export function useProviderInvoices(enabled: boolean) {
  const { can } = useTenant();
  return useStudioQuery<Items<ProviderInvoice>>(
    saasKeys.providerInvoices,
    '/v1/admin/billing/provider-invoices',
    { enabled: enabled && can('billing.read') },
  );
}

/** Upgrade: the provider's checkout page for a plan (the browser goes there next). */
export function useStartCheckout() {
  return useStudioMutation((planKey: string, tenant) =>
    api<{ url: string }>('/v1/admin/billing/checkout', {
      method: 'POST',
      tenant,
      body: { planKey },
      idempotencyKey: newIdempotencyKey(),
    }),
  );
}

/** Manage: the provider's billing portal or client area. */
export function useOpenPortal() {
  return useStudioMutation((_: undefined, tenant) =>
    api<{ url: string }>('/v1/admin/billing/portal', { method: 'POST', tenant }),
  );
}

export function useEmailSender() {
  const { can } = useTenant();
  return useStudioQuery<EmailSenderSettings>(saasKeys.emailSender, '/v1/admin/email-sender', {
    enabled: can('settings.manage'),
  });
}

export function useSetEmailSender() {
  return useStudioMutation(
    (senderName: string | null, tenant) =>
      api<EmailSenderSettings>('/v1/admin/email-sender', {
        method: 'PUT',
        tenant,
        body: { senderName },
      }),
    [saasKeys.emailSender],
  );
}

const settling = (items: ProvisioningStatus[] | undefined) =>
  items?.some((item) => item.state === 'queued' || item.state === 'running') ?? false;

/** The automatic Chatwoot set-up of each brand; checked every few seconds while one runs. */
export function useProvisioning() {
  const { can } = useTenant();
  return useStudioQuery<Items<ProvisioningStatus>>(
    saasKeys.provisioning,
    '/v1/admin/authority/provisioning',
    {
      enabled: can('brands.manage'),
      refetchInterval: (data) => (settling(data?.items) ? 4000 : false),
    },
  );
}

// ── Platform console ──────────────────────────────────────────────────────────────────────────

const meta = { studio: true } as const;

export function usePlatformSignup(enabled: boolean) {
  return useQuery({
    queryKey: saasPlatformKeys.signup,
    queryFn: ({ signal }) => api<PlatformSignup>('/v1/platform/signup', { signal }),
    enabled,
    meta,
  });
}

export function useSetPlatformSignup() {
  return usePlatformMutation(
    (open: boolean | null) =>
      api<PlatformSignup>('/v1/platform/signup', { method: 'PUT', body: { open } }),
    [saasPlatformKeys.signup, saasKeys.signup],
  );
}

export function usePlatformPlans(enabled: boolean) {
  return useQuery({
    queryKey: saasPlatformKeys.plans,
    queryFn: ({ signal }) => api<Items<PlatformPlan>>('/v1/platform/plans', { signal }),
    enabled,
    meta,
  });
}

export function useTenantBilling(id: string) {
  return useQuery({
    queryKey: saasPlatformKeys.tenantBilling(id),
    queryFn: ({ signal }) =>
      api<PlatformTenantBilling>(`/v1/platform/tenants/${encodeURIComponent(id)}/billing`, {
        signal,
      }),
    meta,
  });
}

const tenantKeys = (id: string) => [
  saasPlatformKeys.tenantBilling(id),
  platformKeys.tenant(id),
  ['platform', 'tenants'],
  platformKeys.overview,
];

export function useAssignPlan(id: string) {
  return usePlatformMutation(
    (body: { planKey: string; startTrial: boolean }) =>
      api<PlatformTenantBilling>(`/v1/platform/tenants/${encodeURIComponent(id)}/plan`, {
        method: 'PUT',
        body,
      }),
    tenantKeys(id),
  );
}

export function useSetTenantState(id: string) {
  return usePlatformMutation(
    ({ action, reason }: { action: 'suspend' | 'reactivate'; reason: string }) =>
      api<PlatformTenantBilling>(`/v1/platform/tenants/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        body: { reason },
      }),
    tenantKeys(id),
  );
}

export function useOperatorKeys(enabled: boolean) {
  return useQuery({
    queryKey: saasPlatformKeys.operatorKeys,
    queryFn: ({ signal }) => api<Items<OperatorApiKey>>('/v1/platform/operator-keys', { signal }),
    enabled,
    meta,
  });
}

export function useCreateOperatorKey() {
  return usePlatformMutation(
    (name: string) =>
      api<CreatedOperatorApiKey>('/v1/platform/operator-keys', { method: 'POST', body: { name } }),
    [saasPlatformKeys.operatorKeys],
  );
}

export function useRevokeOperatorKey() {
  return usePlatformMutation(
    (id: string) =>
      api<OperatorApiKey>(`/v1/platform/operator-keys/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
      }),
    [saasPlatformKeys.operatorKeys],
  );
}
