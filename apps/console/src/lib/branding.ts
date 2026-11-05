import { useQuery } from '@tanstack/react-query';
import { api } from './api';
export interface PortalBranding {
  displayName: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  accentColor: string;
  fontFamily: 'system' | 'dm-sans' | 'noto-sans';
  showBranding: boolean;
}
export interface EmailBranding {
  senderName: string | null;
  replyTo: string | null;
  logoUrl: string | null;
}
export interface BrandingDomain {
  id: string;
  hostname: string;
  status: 'pending' | 'verified' | 'active' | 'disabled';
  verification: { name: string; value: string };
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  lastCheckResult: 'verified' | 'not_found' | 'lookup_failed' | null;
  routingReady: boolean;
  tlsReady: boolean;
  createdAt: string;
}
export interface BrandingSettings {
  portal: PortalBranding;
  email: EmailBranding;
  domains: BrandingDomain[];
}
export function usePublicBranding() {
  return useQuery({
    queryKey: [
      'public-branding',
      typeof window === 'undefined' ? 'canonical' : window.location.host,
    ],
    queryFn: ({ signal }) =>
      api<{ portal: PortalBranding; customDomain: boolean }>('/v1/branding', { signal }),
    retry: false,
    staleTime: 60_000,
  });
}
