import { z } from 'zod';
import { LanguageTag, Timestamp } from './common.js';
import { typeId } from './ids.js';

/** Identity and administration API (Hamnivo Studio, blueprint A02/A03/A06/A09). */

export const TenantSlug = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 lowercase letters, digits or hyphens')
  .meta({ description: 'URL-safe tenant handle', example: 'acme-support' });

export const TenantStatus = z.enum(['active', 'suspended', 'closing']);

export const TenantSummary = z
  .object({
    id: typeId('tenant'),
    slug: TenantSlug,
    name: z.string(),
    status: TenantStatus,
  })
  .meta({ id: 'TenantSummary' });

export const CreateTenantRequest = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: TenantSlug,
    defaultLocale: LanguageTag.default('en'),
  })
  .meta({ id: 'CreateTenantRequest' });

export const StaffStatus = z.enum(['invited', 'active', 'suspended', 'removed']);

export const WorkspaceSummary = z
  .object({
    id: typeId('workspace'),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['active', 'archived']),
    brands: z.array(
      z.object({ id: typeId('brand'), name: z.string(), status: z.enum(['active', 'disabled']) }),
    ),
  })
  .meta({ id: 'WorkspaceSummary' });

export const Membership = z
  .object({
    tenant: TenantSummary,
    staffMemberId: typeId('staff'),
    status: StaffStatus,
  })
  .meta({ id: 'Membership' });

export const Me = z
  .object({
    user: z.object({
      id: z.string(),
      name: z.string(),
      email: z.email(),
      emailVerified: z.boolean(),
      twoFactorEnabled: z.boolean(),
    }),
    memberships: z.array(Membership),
    /** Present when the request named a tenant (X-Hamnivo-Tenant) the person belongs to. */
    current: z
      .object({
        tenantId: typeId('tenant'),
        staffMemberId: typeId('staff'),
        permissions: z.array(z.string()),
        mfa: z.boolean(),
      })
      .nullable(),
  })
  .meta({ id: 'Me' });

export const GrantScope = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('tenant') }),
    z.object({ type: z.literal('workspace'), id: typeId('workspace') }),
    z.object({ type: z.literal('brand'), id: typeId('brand') }),
    z.object({ type: z.literal('team'), id: typeId('team') }),
    z.object({ type: z.literal('inbox'), id: typeId('inbox') }),
  ])
  .meta({ id: 'GrantScope' });

export const RoleRef = z.object({ id: typeId('role'), key: z.string(), name: z.string() });

export const Role = z
  .object({
    id: typeId('role'),
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    permissions: z.array(z.string()),
    isPreset: z.boolean(),
    version: z.number().int(),
  })
  .meta({ id: 'Role' });

const RoleKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use 2–40 lowercase letters, digits or _');
const PermissionPattern = z
  .string()
  .regex(/^(\*|[a-z_]+\.(\*|[a-z_]+))$/)
  .meta({ description: 'Permission key, `area.*` or `*`' });

export const CreateRoleRequest = z
  .object({
    key: RoleKey,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(400).optional(),
    permissions: z.array(PermissionPattern).min(1).max(200),
  })
  .meta({ id: 'CreateRoleRequest' });

export const UpdateRoleRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(400).nullable().optional(),
    permissions: z.array(PermissionPattern).min(1).max(200).optional(),
    /** The version you edited; a different current version returns VERSION_CONFLICT. */
    version: z.number().int().min(1),
  })
  .meta({ id: 'UpdateRoleRequest' });

export const GrantView = z
  .object({
    id: typeId('grant'),
    role: RoleRef,
    scope: GrantScope,
    expiresAt: Timestamp.nullable(),
    delegatedBy: typeId('staff').nullable(),
    reason: z.string().nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: 'GrantView' });

export const Member = z
  .object({
    id: typeId('staff'),
    displayName: z.string(),
    email: z.email(),
    status: StaffStatus,
    grants: z.array(GrantView),
    lastActiveAt: Timestamp.nullable(),
  })
  .meta({ id: 'Member' });

export const UpdateMemberRequest = z
  .object({ status: z.enum(['active', 'suspended']), reason: z.string().max(400).optional() })
  .meta({ id: 'UpdateMemberRequest' });

export const CreateGrantRequest = z
  .object({
    staffMemberId: typeId('staff'),
    roleId: typeId('role'),
    scope: GrantScope,
    expiresAt: Timestamp.nullable().default(null),
    reason: z.string().trim().max(400).optional(),
  })
  .meta({ id: 'CreateGrantRequest' });

export const RevokeGrantRequest = z
  .object({ reason: z.string().trim().max(400).optional() })
  .meta({ id: 'RevokeGrantRequest' });

export const CreateInvitationRequest = z
  .object({
    email: z.email(),
    roleId: typeId('role'),
    scope: GrantScope,
    grantExpiresAt: Timestamp.nullable().default(null),
  })
  .meta({ id: 'CreateInvitationRequest' });

export const Invitation = z
  .object({
    id: typeId('invitation'),
    email: z.email(),
    role: RoleRef,
    scope: GrantScope,
    status: z.enum(['pending', 'accepted', 'revoked']),
    expiresAt: Timestamp,
    createdAt: Timestamp,
  })
  .meta({ id: 'Invitation' });

export const CreatedInvitation = Invitation.extend({
  /** One-time secret link part; shown only in this response and in the invitation email. */
  token: z.string(),
}).meta({ id: 'CreatedInvitation' });

export const AcceptInvitationRequest = z
  .object({ token: z.string().min(10).max(200) })
  .meta({ id: 'AcceptInvitationRequest' });

export const PermissionInfo = z
  .object({
    key: z.string(),
    description: z.string(),
    scopes: z.array(z.string()),
    stepUp: z.boolean(),
    mfa: z.boolean(),
  })
  .meta({ id: 'PermissionInfo' });

export const SecretMetadata = z
  .object({
    id: typeId('secret'),
    kind: z.string(),
    label: z.string(),
    /** Last four characters only, e.g. `••••9f3a`. */
    masked: z.string(),
    createdAt: Timestamp,
    rotatedAt: Timestamp.nullable(),
    lastUsedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .meta({ id: 'SecretMetadata' });

export const CreateSecretRequest = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
    label: z.string().trim().min(1).max(120),
    value: z.string().min(1).max(16_384),
  })
  .meta({ id: 'CreateSecretRequest' });

export const RotateSecretRequest = z
  .object({ value: z.string().min(1).max(16_384) })
  .meta({ id: 'RotateSecretRequest' });

export const AuditEventView = z
  .object({
    seq: z.number().int(),
    id: z.string(),
    occurredAt: Timestamp,
    actor: z.object({ type: z.string(), id: z.string().nullable() }),
    action: z.string(),
    target: z.object({ type: z.string(), id: z.string().nullable() }).nullable(),
    outcome: z.enum(['success', 'denied', 'failed']),
    reason: z.string().nullable(),
    requestId: z.string().nullable(),
    data: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'AuditEventView' });

export const AuditPage = z
  .object({ items: z.array(AuditEventView), nextBefore: z.number().int().nullable() })
  .meta({ id: 'AuditPage' });

export const AuditVerification = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), checked: z.number().int(), lastSeq: z.number().int() }),
    z.object({
      ok: z.literal(false),
      seq: z.number().int(),
      reason: z.enum(['gap', 'prev_hash_mismatch', 'hash_mismatch', 'head_mismatch']),
    }),
  ])
  .meta({ id: 'AuditVerification' });
