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
    /** People holding the role through an active grant. */
    memberCount: z.number().int().nonnegative(),
    /**
     * The caller may edit this role: a custom role whose permissions are all within the caller's
     * own tenant-wide access (A12). Built-in roles are never editable.
     */
    editable: z.boolean(),
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
    teams: z.array(z.object({ id: typeId('team'), name: z.string() })),
    lastActiveAt: Timestamp.nullable(),
    /**
     * The caller may change, suspend or remove this person: their access is within the caller's
     * own (A02, A03). The server checks again on every change.
     */
    manageable: z.boolean(),
  })
  .meta({ id: 'Member' });

export const UpdateMemberRequest = z
  .object({ status: z.enum(['active', 'suspended']), reason: z.string().max(400).optional() })
  .meta({ id: 'UpdateMemberRequest' });

export const RemoveMemberRequest = z
  .object({ reason: z.string().trim().max(400).optional() })
  .meta({ id: 'RemoveMemberRequest' });

/** What removing a person affects, shown before it happens (HNV-22-05). */
export const MemberOffboarding = z
  .object({
    member: Member,
    /** Open conversations the person holds; they wait for them until reassigned. */
    openConversations: z.object({
      total: z.number().int().nonnegative(),
      ids: z.array(typeId('conversation')).max(50),
    }),
    /** The caller may reassign them (conversations.bulk). */
    canReassign: z.boolean(),
    /** The person cannot be removed while they are the only owner. */
    lastOwner: z.boolean(),
  })
  .meta({ id: 'MemberOffboarding' });

export const ReplaceGrantRequest = z
  .object({
    roleId: typeId('role'),
    scope: GrantScope,
    expiresAt: Timestamp.nullable().default(null),
    reason: z.string().trim().max(400).optional(),
  })
  .meta({ id: 'ReplaceGrantRequest' });

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
    /** The link stops working at this time; a pending invitation past it is expired. */
    expiresAt: Timestamp,
    createdAt: Timestamp,
    invitedBy: z.object({ id: typeId('staff'), displayName: z.string() }).nullable(),
    acceptedAt: Timestamp.nullable(),
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
    /** The caller holds it across the tenant, so may put it into a role (A12). */
    grantable: z.boolean(),
  })
  .meta({ id: 'PermissionInfo' });

export const RolePreviewRequest = z
  .object({
    /** The role being edited; omit when building a new one. */
    roleId: typeId('role').optional(),
    permissions: z.array(PermissionPattern).max(200),
  })
  .meta({ id: 'RolePreviewRequest' });

/** What saving a role would change, before it is saved (A12, HNV-22-03, HNV-22-04). */
export const RolePreview = z
  .object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    /** Added permissions that need two-step verification or a fresh sign-in. */
    addedSensitive: z.array(z.string()),
    /** Permissions the caller cannot put into a role (outside their tenant-wide access). */
    outsideReach: z.array(z.string()),
    /** People holding the role, and what each gains or loses. */
    impact: z.array(
      z.object({
        staffMemberId: typeId('staff'),
        displayName: z.string(),
        gains: z.array(z.string()),
        loses: z.array(z.string()),
      }),
    ),
    /** The role's current version (for VERSION_CONFLICT on save). */
    version: z.number().int().nullable(),
  })
  .meta({ id: 'RolePreview' });

export const AuditFilters = z.object({
  action: z.string().max(80).optional(),
  actorType: z
    .enum(['staff', 'service_account', 'customer', 'ai', 'system', 'platform'])
    .optional(),
  actorId: z.string().max(80).optional(),
  targetType: z.string().max(80).optional(),
  targetId: z.string().max(120).optional(),
  from: Timestamp.optional(),
  to: Timestamp.optional(),
});

export const AuditExportQuery = AuditFilters.extend({
  format: z.enum(['csv', 'ndjson']).default('ndjson'),
}).meta({ id: 'AuditExportQuery' });

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
