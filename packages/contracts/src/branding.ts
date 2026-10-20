import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';
import type { RouteDef } from './routes.js';

const httpsAsset = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, 'Use an HTTPS image URL without credentials');
export const PortalBranding = z.object({
  displayName: z.string().trim().min(1).max(120),
  logoUrl: httpsAsset.nullable(),
  faviconUrl: httpsAsset.nullable(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  fontFamily: z.enum(['system', 'dm-sans', 'noto-sans']),
  showBranding: z.boolean(),
});
export type PortalBranding = z.infer<typeof PortalBranding>;
export const CustomerEmailBranding = z.object({
  senderName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\r\n<>"]+$/)
    .refine(
      (value) => [...value].every((char) => char.codePointAt(0)! >= 32),
      'Control characters are not allowed',
    )
    .nullable(),
  replyTo: z.email().max(254).nullable(),
  logoUrl: httpsAsset.nullable(),
});
export type CustomerEmailBranding = z.infer<typeof CustomerEmailBranding>;
export const BrandingHostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Enter a DNS hostname, without a scheme, port, wildcard or path',
  )
  .refine(
    (value) =>
      !value.endsWith('.localhost') && !value.endsWith('.local') && !value.endsWith('.internal'),
    'Use a public DNS hostname',
  );
export const BrandingDomain = z.object({
  id: typeId('brandingDomain'),
  hostname: BrandingHostname,
  status: z.enum(['pending', 'verified', 'active', 'disabled']),
  verification: z.object({ name: z.string(), value: z.string() }),
  verifiedAt: Timestamp.nullable(),
  lastCheckedAt: Timestamp.nullable(),
  lastCheckResult: z.enum(['verified', 'not_found', 'lookup_failed']).nullable(),
  routingReady: z.boolean(),
  tlsReady: z.boolean(),
  createdAt: Timestamp,
});
export type BrandingDomain = z.infer<typeof BrandingDomain>;
export const UpdateBrandingRequest = z.object({
  portal: PortalBranding,
  email: CustomerEmailBranding,
});
export type UpdateBrandingRequest = z.infer<typeof UpdateBrandingRequest>;
export const BrandingSettings = UpdateBrandingRequest.extend({ domains: z.array(BrandingDomain) });
export type BrandingSettings = z.infer<typeof BrandingSettings>;
export const RegisterBrandingDomainRequest = z.object({ hostname: BrandingHostname });
export const PublicPortalBranding = z.object({ portal: PortalBranding, customDomain: z.boolean() });
export const DEFAULT_PORTAL_BRANDING: PortalBranding = {
  displayName: 'Hamnivo',
  logoUrl: null,
  faviconUrl: null,
  accentColor: '#0d9488',
  fontFamily: 'system',
  showBranding: true,
};
export const DEFAULT_EMAIL_BRANDING: CustomerEmailBranding = {
  senderName: null,
  replyTo: null,
  logoUrl: null,
};
const params = z.object({ id: typeId('brandingDomain') });
export const brandingRoutes = {
  getBranding: {
    method: 'get',
    path: '/v1/admin/branding',
    operationId: 'getBranding',
    summary: 'Portal and customer email branding (branding.read)',
    tags: ['Branding'],
    auth: 'staff_session',
    success: { status: 200, description: 'Branding settings', schema: BrandingSettings },
  },
  updateBranding: {
    method: 'put',
    path: '/v1/admin/branding',
    operationId: 'updateBranding',
    summary: 'Save portal and customer email branding (branding.manage, fresh sign-in)',
    tags: ['Branding'],
    auth: 'staff_session',
    body: UpdateBrandingRequest,
    success: { status: 200, description: 'Saved settings', schema: BrandingSettings },
  },
  registerBrandingDomain: {
    method: 'post',
    path: '/v1/admin/branding/domains',
    operationId: 'registerBrandingDomain',
    summary: 'Register a custom portal hostname (branding.manage)',
    tags: ['Branding'],
    auth: 'staff_session',
    body: RegisterBrandingDomainRequest,
    success: { status: 201, description: 'DNS challenge', schema: BrandingDomain },
  },
  verifyBrandingDomain: {
    method: 'post',
    path: '/v1/admin/branding/domains/{id}/verify',
    operationId: 'verifyBrandingDomain',
    summary: 'Check DNS ownership (branding.manage)',
    tags: ['Branding'],
    auth: 'staff_session',
    params,
    success: { status: 200, description: 'Verification status', schema: BrandingDomain },
  },
  disableBrandingDomain: {
    method: 'post',
    path: '/v1/admin/branding/domains/{id}/disable',
    operationId: 'disableBrandingDomain',
    summary: 'Disable a portal hostname (branding.manage)',
    tags: ['Branding'],
    auth: 'staff_session',
    params,
    success: { status: 200, description: 'Disabled domain', schema: BrandingDomain },
  },
  publicPortalBranding: {
    method: 'get',
    path: '/v1/branding',
    operationId: 'publicPortalBranding',
    summary: 'Safe public branding for the current host',
    tags: ['Branding'],
    auth: 'public',
    success: { status: 200, description: 'Public portal appearance', schema: PublicPortalBranding },
  },
} as const satisfies Record<string, RouteDef>;
