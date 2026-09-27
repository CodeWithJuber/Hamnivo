import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  CreatedInvitation,
  CreateGrantRequest,
  CreateInvitationRequest,
  CreateRoleRequest,
  GrantView,
  Invitation,
  Member,
  Membership,
  Role,
  UpdateMemberRequest,
  UpdateRoleRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  newId,
  resolveInvitation,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  appliesAtScope,
  authorize,
  checkDelegation,
  type DelegationProblem,
  diffPermissions,
  expandPatterns,
  type Permission,
  rolePatterns,
  type Scope,
  type StaffPrincipal,
  validatePatterns,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { iso, scopeFromContract, scopeToContract } from '../common/views.js';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { scopeFromRow } from '../identity/principal.service.js';
import { enforce } from '../identity/staff.guard.js';
import { TenantsService } from '../identity/tenants.service.js';
import type { Mailer } from '../platform/mailer.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { resourceFor, scopeParents } from './scopes.js';

type GrantViewT = z.infer<typeof GrantView>;
type MemberT = z.infer<typeof Member>;
type RoleT = z.infer<typeof Role>;
type InvitationT = z.infer<typeof Invitation>;
type CreatedInvitationT = z.infer<typeof CreatedInvitation>;
type MembershipT = z.infer<typeof Membership>;

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

const DELEGATION_TEXT: Record<DelegationProblem['code'], string> = {
  not_allowed: "You can't grant access in this area.",
  self_grant: "You can't change your own access.",
  exceeds_own_permissions: 'You can only grant permissions you hold yourself.',
  outside_own_scope: 'You can only grant access inside the area you manage.',
  expiry_beyond_own: 'The access must expire no later than your own.',
};

function delegationError(problems: DelegationProblem[]): AppError {
  return new AppError('SCOPE_DENIED', {
    detail: [...new Set(problems.map((p) => DELEGATION_TEXT[p.code]))].join(' '),
    internal: problems,
  });
}

/** A grant whose role has no permission at that level would do nothing; say so instead. */
function assertApplicable(patterns: readonly string[], scope: Scope) {
  if (!expandPatterns(patterns).some((p) => appliesAtScope(p, scope.type))) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'scope', message: 'This role has no permissions that apply at this level' }],
    });
  }
}

function roleView(row: typeof schema.roleDefinitions.$inferSelect): RoleT {
  return {
    id: toPublicId('role', row.id),
    key: row.key,
    name: row.name,
    description: row.description,
    permissions: rolePatterns(row),
    isPreset: row.isPreset,
    version: row.version,
  };
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly tenants: TenantsService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(principal: StaffPrincipal, permission: Permission, resource = {}) {
    enforce(
      authorize(principal, permission, resource, {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
      }),
    );
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    entry: Omit<Parameters<typeof appendAudit>[1], 'actorType' | 'actorId' | 'outcome'>,
  ) {
    return appendAudit(tx, {
      ...entry,
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      outcome: 'success',
    });
  }

  /** The tenant must always keep at least one active owner (a `*` grant at tenant scope). */
  private async assertOwnersRemain(
    tx: TenantTx,
    change: { withoutGrant?: string; withoutMember?: string },
  ) {
    const owners = await tx
      .select({
        grantId: schema.grants.id,
        staffMemberId: schema.grants.staffMemberId,
        permissions: schema.roleDefinitions.permissions,
      })
      .from(schema.grants)
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.grants.staffMemberId))
      .where(
        and(
          isNull(schema.grants.revokedAt),
          eq(schema.grants.scopeType, 'tenant'),
          eq(schema.staffMembers.status, 'active'),
        ),
      );
    const remaining = owners.filter(
      (o) =>
        o.permissions.includes('*') &&
        o.grantId !== change.withoutGrant &&
        o.staffMemberId !== change.withoutMember,
    );
    if (remaining.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The workspace must keep at least one owner. Make someone else an owner first.',
      });
    }
  }

  private async grantViews(
    tx: TenantTx,
    staffMemberIds: string[],
  ): Promise<Map<string, GrantViewT[]>> {
    const result = new Map<string, GrantViewT[]>();
    if (staffMemberIds.length === 0) return result;
    const rows = await tx
      .select({ grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(
        and(inArray(schema.grants.staffMemberId, staffMemberIds), isNull(schema.grants.revokedAt)),
      )
      .orderBy(asc(schema.grants.createdAt));
    for (const { grant, role } of rows) {
      if (!grant.staffMemberId) continue;
      const list = result.get(grant.staffMemberId) ?? [];
      list.push(this.grantView(grant, role));
      result.set(grant.staffMemberId, list);
    }
    return result;
  }

  private grantView(
    grant: typeof schema.grants.$inferSelect,
    role: typeof schema.roleDefinitions.$inferSelect,
  ): GrantViewT {
    return {
      id: toPublicId('grant', grant.id),
      role: { id: toPublicId('role', role.id), key: role.key, name: role.name },
      scope: scopeToContract(scopeFromRow(grant.scopeType, grant.scopeId)),
      expiresAt: iso(grant.expiresAt),
      delegatedBy: grant.delegatedBy ? toPublicId('staff', grant.delegatedBy) : null,
      reason: grant.reason,
      createdAt: grant.createdAt.toISOString(),
    };
  }

  // ── Workspaces ─────────────────────────────────────────────────────────────────────────────

  async listWorkspaces(principal: StaffPrincipal) {
    return this.tx(principal, async (tx) => {
      const workspaces = await tx
        .select()
        .from(schema.workspaces)
        .orderBy(asc(schema.workspaces.name));
      const brands = await tx.select().from(schema.brands).orderBy(asc(schema.brands.name));
      return workspaces.map((w) => ({
        id: toPublicId('workspace', w.id),
        name: w.name,
        slug: w.slug,
        status: w.status,
        brands: brands
          .filter((b) => b.workspaceId === w.id)
          .map((b) => ({ id: toPublicId('brand', b.id), name: b.name, status: b.status })),
      }));
    });
  }

  // ── Members ────────────────────────────────────────────────────────────────────────────────

  async listMembers(principal: StaffPrincipal): Promise<MemberT[]> {
    return this.tx(principal, async (tx) => {
      const members = await tx
        .select()
        .from(schema.staffMembers)
        .where(ne(schema.staffMembers.status, 'removed'))
        .orderBy(asc(schema.staffMembers.displayName));
      const grants = await this.grantViews(
        tx,
        members.map((m) => m.id),
      );
      return members.map((m) => ({
        id: toPublicId('staff', m.id),
        displayName: m.displayName,
        email: m.email,
        status: m.status,
        grants: grants.get(m.id) ?? [],
        lastActiveAt: iso(m.lastActiveAt),
      }));
    });
  }

  async updateMember(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateMemberRequest>,
  ): Promise<MemberT> {
    const staffMemberId = this.parseId('staff', publicId);
    if (staffMemberId === principal.staffMemberId) {
      throw new AppError('VALIDATION_FAILED', { detail: "You can't change your own status." });
    }
    await this.tx(principal, async (tx) => {
      const [member] = await tx
        .select()
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, staffMemberId))
        .for('update');
      if (!member || member.status === 'removed') throw new AppError('NOT_FOUND');
      if (input.status === 'suspended')
        await this.assertOwnersRemain(tx, { withoutMember: staffMemberId });
      await tx
        .update(schema.staffMembers)
        .set({ status: input.status })
        .where(eq(schema.staffMembers.id, staffMemberId));
      await this.audit(tx, principal, {
        action: input.status === 'suspended' ? 'member.suspended' : 'member.restored',
        targetType: 'staff',
        targetId: publicId,
        reason: input.reason ?? null,
      });
    });
    const members = await this.listMembers(principal);
    const updated = members.find((m) => m.id === publicId);
    if (!updated) throw new AppError('NOT_FOUND');
    return updated;
  }

  // ── Roles ──────────────────────────────────────────────────────────────────────────────────

  async listRoles(principal: StaffPrincipal): Promise<RoleT[]> {
    return this.tx(principal, async (tx) =>
      (
        await tx
          .select()
          .from(schema.roleDefinitions)
          .orderBy(asc(schema.roleDefinitions.isPreset), asc(schema.roleDefinitions.name))
      ).map(roleView),
    );
  }

  /** Nobody can put a permission into a role that they don't hold across the whole tenant. */
  private assertHoldsTenantWide(principal: StaffPrincipal, permissions: Permission[]) {
    const now = this.clock();
    const missing = permissions.filter((permission) => {
      const decision = authorize(
        principal,
        permission,
        {},
        { now, stepUpMaxAgeMs: Number.POSITIVE_INFINITY },
      );
      return (
        !decision.allowed && (decision.reason === 'no_grant' || decision.reason === 'outside_scope')
      );
    });
    if (missing.length > 0) {
      throw new AppError('SCOPE_DENIED', {
        detail: `You can only include permissions you hold across the whole workspace (missing: ${missing.join(', ')}).`,
      });
    }
  }

  private assertValidPatterns(patterns: string[]) {
    const invalid = validatePatterns(patterns);
    if (invalid.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        fields: invalid.map((p) => ({ path: 'permissions', message: `Unknown permission: ${p}` })),
      });
    }
  }

  async createRole(
    principal: StaffPrincipal,
    input: z.output<typeof CreateRoleRequest>,
  ): Promise<RoleT> {
    this.assertValidPatterns(input.permissions);
    this.assertHoldsTenantWide(principal, expandPatterns(input.permissions));
    try {
      return await this.tx(principal, async (tx) => {
        const [row] = await tx
          .insert(schema.roleDefinitions)
          .values({
            tenantId: principal.tenantId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            permissions: input.permissions,
          })
          .returning();
        if (!row) throw new Error('role not returned');
        await this.audit(tx, principal, {
          action: 'role.created',
          targetType: 'role',
          targetId: toPublicId('role', row.id),
          data: { key: row.key, permissions: expandPatterns(row.permissions) },
        });
        return roleView(row);
      });
    } catch (error) {
      if (isUniqueViolation(error, 'role_definitions_key_key')) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'key', message: 'A role with this key exists' }],
        });
      }
      throw error;
    }
  }

  async updateRole(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateRoleRequest>,
  ): Promise<RoleT> {
    const roleId = this.parseId('role', publicId);
    if (input.permissions) this.assertValidPatterns(input.permissions);
    return this.tx(principal, async (tx) => {
      const [role] = await tx
        .select()
        .from(schema.roleDefinitions)
        .where(eq(schema.roleDefinitions.id, roleId))
        .for('update');
      if (!role) throw new AppError('NOT_FOUND');
      if (role.isPreset) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Built-in roles cannot be edited. Create a custom role instead.',
        });
      }
      if (role.version !== input.version) throw new AppError('VERSION_CONFLICT');
      const diff = input.permissions ? diffPermissions(role.permissions, input.permissions) : null;
      if (diff) this.assertHoldsTenantWide(principal, diff.added);
      const [updated] = await tx
        .update(schema.roleDefinitions)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
          version: role.version + 1,
        })
        .where(eq(schema.roleDefinitions.id, roleId))
        .returning();
      if (!updated) throw new Error('role not returned');
      await this.audit(tx, principal, {
        action: 'role.updated',
        targetType: 'role',
        targetId: publicId,
        data: {
          version: updated.version,
          ...(diff
            ? { added: diff.added, removed: diff.removed, addedSensitive: diff.addedSensitive }
            : {}),
        },
      });
      return roleView(updated);
    });
  }

  // ── Grants ─────────────────────────────────────────────────────────────────────────────────

  async createGrant(
    principal: StaffPrincipal,
    input: z.output<typeof CreateGrantRequest>,
  ): Promise<GrantViewT> {
    const staffMemberId = this.parseId('staff', input.staffMemberId);
    const roleId = this.parseId('role', input.roleId);
    const scope = scopeFromContract(input.scope);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    return this.tx(principal, async (tx) => {
      const [role] = await tx
        .select()
        .from(schema.roleDefinitions)
        .where(eq(schema.roleDefinitions.id, roleId));
      const [member] = await tx
        .select()
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, staffMemberId));
      if (!role || !member || member.status === 'removed') throw new AppError('NOT_FOUND');
      const permissions = rolePatterns(role);
      assertApplicable(permissions, scope);
      const parents = await scopeParents(tx, scope);
      const problems = checkDelegation(
        principal,
        { granteeStaffMemberId: staffMemberId, permissions, scope, expiresAt },
        () => parents,
        this.clock(),
      );
      if (problems.length > 0) throw delegationError(problems);
      this.decide(principal, 'grants.manage', resourceFor(scope, parents));
      const [grant] = await tx
        .insert(schema.grants)
        .values({
          tenantId: principal.tenantId,
          staffMemberId,
          roleId,
          scopeType: scope.type,
          scopeId: scope.type === 'tenant' ? null : scope.id,
          delegatedBy: principal.staffMemberId,
          reason: input.reason ?? null,
          expiresAt,
        })
        .returning();
      if (!grant) throw new Error('grant not returned');
      const view = this.grantView(grant, role);
      await this.audit(tx, principal, {
        action: 'grant.created',
        targetType: 'staff',
        targetId: input.staffMemberId,
        reason: input.reason ?? null,
        data: { grant: view.id, role: role.key, scope: view.scope, expiresAt: view.expiresAt },
      });
      return view;
    });
  }

  async revokeGrant(
    principal: StaffPrincipal,
    publicId: string,
    reason: string | undefined,
  ): Promise<void> {
    const grantId = this.parseId('grant', publicId);
    await this.tx(principal, async (tx) => {
      const [grant] = await tx
        .select()
        .from(schema.grants)
        .where(eq(schema.grants.id, grantId))
        .for('update');
      if (!grant) throw new AppError('NOT_FOUND');
      if (grant.revokedAt) return;
      const scope: Scope = scopeFromRow(grant.scopeType, grant.scopeId);
      this.decide(principal, 'grants.manage', resourceFor(scope, await scopeParents(tx, scope)));
      if (grant.staffMemberId === principal.staffMemberId) {
        throw new AppError('VALIDATION_FAILED', { detail: "You can't revoke your own access." });
      }
      await this.assertOwnersRemain(tx, { withoutGrant: grantId });
      await tx
        .update(schema.grants)
        .set({ revokedAt: this.clock(), revokedBy: principal.staffMemberId })
        .where(eq(schema.grants.id, grantId));
      await this.audit(tx, principal, {
        action: 'grant.revoked',
        targetType: 'staff',
        targetId: grant.staffMemberId ? toPublicId('staff', grant.staffMemberId) : null,
        reason: reason ?? null,
        data: { grant: publicId },
      });
    });
  }

  // ── Invitations ────────────────────────────────────────────────────────────────────────────

  private invitationView(
    row: typeof schema.invitations.$inferSelect,
    role: typeof schema.roleDefinitions.$inferSelect,
  ): InvitationT {
    return {
      id: toPublicId('invitation', row.id),
      email: row.email,
      role: { id: toPublicId('role', role.id), key: role.key, name: role.name },
      scope: scopeToContract(scopeFromRow(row.scopeType, row.scopeId)),
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async createInvitation(
    principal: StaffPrincipal,
    input: z.output<typeof CreateInvitationRequest>,
  ): Promise<CreatedInvitationT> {
    const roleId = this.parseId('role', input.roleId);
    const scope = scopeFromContract(input.scope);
    const grantExpiresAt = input.grantExpiresAt ? new Date(input.grantExpiresAt) : null;
    const secret = randomBytes(24).toString('base64url');
    const id = newId();
    const now = this.clock();
    const created = await this.tx(principal, async (tx) => {
      const [role] = await tx
        .select()
        .from(schema.roleDefinitions)
        .where(eq(schema.roleDefinitions.id, roleId));
      if (!role) throw new AppError('NOT_FOUND');
      const permissions = rolePatterns(role);
      assertApplicable(permissions, scope);
      const parents = await scopeParents(tx, scope);
      const problems = checkDelegation(
        principal,
        {
          granteeStaffMemberId: `invitation:${id}`,
          permissions,
          scope,
          expiresAt: grantExpiresAt,
        },
        () => parents,
        now,
        'members.invite',
      );
      if (problems.length > 0) throw delegationError(problems);
      const [existing] = await tx
        .select({ id: schema.staffMembers.id })
        .from(schema.staffMembers)
        .where(
          and(eq(schema.staffMembers.email, input.email), eq(schema.staffMembers.status, 'active')),
        );
      if (existing) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'email', message: 'Already a member' }],
        });
      }
      const [row] = await tx
        .insert(schema.invitations)
        .values({
          id,
          tenantId: principal.tenantId,
          email: input.email,
          roleId,
          scopeType: scope.type,
          scopeId: scope.type === 'tenant' ? null : scope.id,
          grantExpiresAt,
          tokenHash: sha256(secret),
          invitedBy: principal.staffMemberId,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        })
        .returning();
      if (!row) throw new Error('invitation not returned');
      const view = this.invitationView(row, role);
      await this.audit(tx, principal, {
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: view.id,
        data: { email: input.email, role: role.key, scope: view.scope },
      });
      return view;
    });
    const token = `${created.id}.${secret}`;
    await this.mailer.send({
      to: input.email,
      template: 'members.invitation',
      subject: 'You have been invited to Hamnivo',
      text: `You were invited to join a Hamnivo workspace as ${created.role.name}.\n\nAccept within 7 days:\n${this.config.PUBLIC_CONSOLE_ORIGIN}/invitations/accept?token=${encodeURIComponent(token)}\n\nSign in with this email address (${input.email}) to accept.`,
    });
    return { ...created, token };
  }

  async listInvitations(principal: StaffPrincipal): Promise<InvitationT[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select({ invitation: schema.invitations, role: schema.roleDefinitions })
        .from(schema.invitations)
        .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.invitations.roleId))
        .orderBy(asc(schema.invitations.createdAt));
      return rows.map(({ invitation, role }) => this.invitationView(invitation, role));
    });
  }

  async revokeInvitation(principal: StaffPrincipal, publicId: string): Promise<void> {
    const invitationId = this.parseId('invitation', publicId);
    await this.tx(principal, async (tx) => {
      const [row] = await tx
        .update(schema.invitations)
        .set({ status: 'revoked' })
        .where(
          and(eq(schema.invitations.id, invitationId), eq(schema.invitations.status, 'pending')),
        )
        .returning();
      if (!row) return;
      await this.audit(tx, principal, {
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: publicId,
      });
    });
  }

  /**
   * Accepts an invitation for the signed-in person. Their email must be verified (server-side
   * challenge) and equal to the invited address; the token secret is compared in constant time.
   */
  async acceptInvitation(session: AuthSession, token: string): Promise<MembershipT> {
    const [publicId, secret] = token.split('.', 2);
    let invitationId: string;
    try {
      invitationId = fromPublicId('invitation', publicId ?? '');
    } catch {
      throw new AppError('NOT_FOUND');
    }
    const resolved = await resolveInvitation(this.db, invitationId);
    if (resolved?.status !== 'pending' || resolved.expiresAt <= this.clock()) {
      throw new AppError('NOT_FOUND', { detail: 'This invitation is no longer valid.' });
    }
    if (!session.user.emailVerified) {
      throw new AppError('IDENTITY_REQUIRED', {
        detail: 'Verify your email address before accepting.',
      });
    }
    await withTenant(
      this.db,
      { tenantId: resolved.tenantId, actorId: session.user.id },
      async (tx) => {
        const [invitation] = await tx
          .select()
          .from(schema.invitations)
          .where(eq(schema.invitations.id, invitationId))
          .for('update');
        const given = sha256(secret ?? '');
        if (
          invitation?.status !== 'pending' ||
          !timingSafeEqual(invitation.tokenHash, given) ||
          invitation.email.toLowerCase() !== session.user.email.toLowerCase()
        ) {
          throw new AppError('NOT_FOUND', { detail: 'This invitation is no longer valid.' });
        }
        const [existing] = await tx
          .select()
          .from(schema.staffMembers)
          .where(eq(schema.staffMembers.authUserId, session.user.id));
        let staffMemberId = existing?.id;
        if (existing) {
          if (existing.status !== 'active') {
            await tx
              .update(schema.staffMembers)
              .set({ status: 'active' })
              .where(eq(schema.staffMembers.id, existing.id));
          }
        } else {
          staffMemberId = newId();
          await tx.insert(schema.staffMembers).values({
            id: staffMemberId,
            tenantId: resolved.tenantId,
            authUserId: session.user.id,
            displayName: session.user.name,
            email: session.user.email,
            status: 'active',
          });
        }
        await tx.insert(schema.grants).values({
          tenantId: resolved.tenantId,
          staffMemberId: staffMemberId as string,
          roleId: invitation.roleId,
          scopeType: invitation.scopeType,
          scopeId: invitation.scopeId,
          delegatedBy: invitation.invitedBy,
          expiresAt: invitation.grantExpiresAt,
          reason: 'Accepted invitation',
        });
        await tx
          .update(schema.invitations)
          .set({
            status: 'accepted',
            acceptedAt: this.clock(),
            acceptedStaffMemberId: staffMemberId,
          })
          .where(eq(schema.invitations.id, invitationId));
        await appendAudit(tx, {
          actorType: 'staff',
          actorId: toPublicId('staff', staffMemberId as string),
          action: 'invitation.accepted',
          targetType: 'invitation',
          targetId: toPublicId('invitation', invitationId),
          outcome: 'success',
        });
      },
    );
    const membership = await this.tenants.membership(session.user.id, resolved.tenantId);
    if (!membership) throw new Error('membership missing after acceptance');
    return membership;
  }

  private parseId(kind: 'staff' | 'role' | 'grant' | 'invitation', publicId: string): string {
    try {
      return fromPublicId(kind, publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
  }
}
