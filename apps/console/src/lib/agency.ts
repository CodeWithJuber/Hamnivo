import { api } from './api';
import { useStudioQuery } from './queries';
import { useTenant } from './tenant';
export interface Agency {
  enabled: boolean;
  branding: { displayName: string | null; accentColor: string | null };
  clientLimit: number | null;
}
export interface AgencyClient {
  tenant: { id: string; slug: string; name: string; status: string };
  linkedAt: string;
  canAccess: boolean;
}
export function useAgency() {
  const { can } = useTenant();
  return useStudioQuery<Agency>(['agency'], '/v1/admin/agency', { enabled: can('agency.read') });
}
export const agencyRequest = <T>(
  path: string,
  tenant: string,
  body?: unknown,
  method: 'POST' | 'DELETE' = 'POST',
  idempotencyKey?: string,
) =>
  api<T>(`/v1/admin/agency/clients${path}`, {
    tenant,
    method,
    body,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
