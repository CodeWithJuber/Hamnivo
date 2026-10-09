import { z } from 'zod';
import { RoleRef } from './admin.js';
import { ChannelKind } from './channels.js';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/** Enterprise sign-in (A13) and support access (A18) for a tenant's Studio. */

const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(
    /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Use a domain such as example.com',
  )
  .meta({ description: 'Email domain, e.g. northline.example', example: 'northline.example' });

export const SsoDomainCheck = z.enum([
  'verified',
  'not_found',
  'lookup_failed',
  'claimed_elsewhere',
]);

export const SsoDomain = z
  .object({
    id: typeId('ssoDomain'),
    domain: z.string(),
    status: z.enum(['pending', 'verified']),
    /** The DNS TXT record that proves the tenant owns the domain. */
    verification: z.object({ name: z.string(), value: z.string() }),
    verifiedAt: Timestamp.nullable(),
    lastCheckedAt: Timestamp.nullable(),
    lastCheckResult: SsoDomainCheck.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'SsoDomain' });
export type SsoDomain = z.infer<typeof SsoDomain>;

export const AddSsoDomainRequest = z.object({ domain: Domain }).meta({ id: 'AddSsoDomainRequest' });

/** HTTPS, or plain HTTP only for an origin the server administrator trusts (a local IdP). */
const IssuerUrl = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .meta({ description: 'Issuer URL of the identity provider' });

export const SsoConnection = z
  .object({
    id: typeId('ssoConnection'),
    domainId: typeId('ssoDomain'),
    domain: z.string(),
    protocol: z.literal('oidc'),
    issuer: z.string(),
    clientId: z.string(),
    /** The client secret is write-only: only its last characters are ever shown. */
    clientSecret: z.object({ masked: z.string(), rotatedAt: Timestamp.nullable() }),
    endpoints: z.object({
      authorization: z.string(),
      token: z.string(),
      jwks: z.string(),
      userInfo: z.string().nullable(),
    }),
    scopes: z.array(z.string()),
    status: z.enum(['draft', 'active', 'disabled']),
    /** People with an address in the domain must use this connection to sign in. */
    ssoOnly: z.boolean(),
    /** Just-in-time membership: a first sign-in joins the workspace with this role. */
    jitRole: RoleRef.nullable(),
    /** Register this address as the redirect URI at the identity provider. */
    callbackUrl: z.string(),
    version: z.number().int(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'SsoConnection' });
export type SsoConnection = z.infer<typeof SsoConnection>;

export const SsoSettings = z
  .object({ domains: z.array(SsoDomain), connections: z.array(SsoConnection) })
  .meta({ id: 'SsoSettings' });
export type SsoSettings = z.infer<typeof SsoSettings>;

export const CreateSsoConnectionRequest = z
  .object({
    domainId: typeId('ssoDomain'),
    issuer: IssuerUrl,
    clientId: z.string().trim().min(1).max(255),
    clientSecret: z.string().min(1).max(4096),
    scopes: z
      .array(z.string().regex(/^[\w:./-]{1,64}$/))
      .max(20)
      .optional(),
  })
  .meta({ id: 'CreateSsoConnectionRequest' });

export const UpdateSsoConnectionRequest = z
  .object({
    /** The version you edited; a different current version returns VERSION_CONFLICT. */
    version: z.number().int().min(1),
    issuer: IssuerUrl.optional(),
    clientId: z.string().trim().min(1).max(255).optional(),
    /** A new secret replaces the stored one; omit to keep it. */
    clientSecret: z.string().min(1).max(4096).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    ssoOnly: z.boolean().optional(),
    /** Role for just-in-time membership; null turns it off. */
    jitRoleId: typeId('role').nullable().optional(),
  })
  .meta({ id: 'UpdateSsoConnectionRequest' });

// ── Support access ───────────────────────────────────────────────────────────────────────────

/** What an approved support session may read. Support access is always read-only. */
export const SupportScope = z.enum(['configuration', 'conversations', 'audit']);
export type SupportScope = z.infer<typeof SupportScope>;

export const SupportGrantState = z.enum([
  'pending',
  'active',
  'declined',
  'revoked',
  'ended',
  'expired',
]);

export const SupportGrant = z
  .object({
    id: typeId('supportGrant'),
    tenant: z.object({ id: typeId('tenant'), name: z.string() }),
    operator: z.object({ id: typeId('operator'), name: z.string() }),
    state: SupportGrantState,
    scopes: z.array(SupportScope),
    reason: z.string(),
    durationMinutes: z.number().int(),
    requestedAt: Timestamp,
    decidedAt: Timestamp.nullable(),
    decidedBy: z.object({ id: typeId('staff'), displayName: z.string() }).nullable(),
    decisionNote: z.string().nullable(),
    /** Access runs from approval to this time, unless revoked or ended first. */
    expiresAt: Timestamp,
    revokedAt: Timestamp.nullable(),
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: 'SupportGrant' });
export type SupportGrant = z.infer<typeof SupportGrant>;

export const ApproveSupportRequest = z
  .object({
    /** Narrow what the operator asked for; never widen it. */
    scopes: z.array(SupportScope).min(1).max(3).optional(),
    durationMinutes: z.number().int().min(5).max(1440).optional(),
    note: z.string().trim().max(400).optional(),
  })
  .meta({ id: 'ApproveSupportRequest' });

export const DecideSupportRequest = z
  .object({ note: z.string().trim().max(400).optional() })
  .meta({ id: 'DecideSupportRequest' });

// ── Notices every member sees ────────────────────────────────────────────────────────────────

export const IncidentSeverity = z.enum(['notice', 'degraded', 'outage']);

export const IncidentNotice = z
  .object({
    id: typeId('incident'),
    title: z.string(),
    message: z.string(),
    severity: IncidentSeverity,
    startedAt: Timestamp,
  })
  .meta({ id: 'IncidentNotice' });
export type IncidentNotice = z.infer<typeof IncidentNotice>;

/** Banners for the Studio shell: active support access and platform incidents (A17, A18). */
export const WorkspaceNotices = z
  .object({
    supportAccess: z.array(
      z.object({
        id: typeId('supportGrant'),
        operatorName: z.string(),
        scopes: z.array(SupportScope),
        expiresAt: Timestamp,
      }),
    ),
    pendingSupportRequests: z.number().int().nonnegative(),
    incidents: z.array(IncidentNotice),
    /**
     * Email, WhatsApp and Telegram channels that have not worked for more than 15 minutes, for
     * people who manage the brand's integrations (A11); empty for everyone else.
     */
    unhealthyChannels: z.array(
      z.object({
        id: typeId('inbox'),
        brandId: typeId('brand'),
        brandName: z.string(),
        kind: ChannelKind,
        name: z.string(),
        address: z.string().nullable(),
        problem: z.string().nullable(),
        since: Timestamp,
      }),
    ),
  })
  .meta({ id: 'WorkspaceNotices' });
export type WorkspaceNotices = z.infer<typeof WorkspaceNotices>;
