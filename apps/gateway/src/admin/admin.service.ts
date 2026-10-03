import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  CreatedInvitation,
  CreateGrantRequest,
  CreateInvitationRequest,
  CreateRoleRequest,
  GrantView,
  Invitation,
  Member,
  MemberOffboarding,
  Membership,
  PermissionInfo,
  ReplaceGrantRequest,
  Role,
  RolePreview,
  RolePreviewRequest,
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
  authorizeAny,
  checkDelegation,
  checkRevocation,
  diffPermissions,
  expandPatterns,
  type HeldGrant,
  PERMISSION_KEYS,
  PERMISSIONS,
  type Permission,
  type ResourceScope,
  roleChangeImpact,
  rolePatterns,
  type Scope,
  type StaffPrincipal,
  unreachablePermissions,
  validatePatterns,
} from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { iso, scopeFromContract, scopeToContract } from '../common/views.js';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { scopeFromRow } from '../identity/principal.service.js';
import { endSessionsIfNoAccessLeft } from '../identity/sessions.js';
import { enforce } from '../identity/staff.guard.js';
import { TenantsService } from '../identity/tenants.service.js';
import { type Mailer, sendTemplate } from '../platform/mailer.js';
import { senderNameOf } from '../platform/workspace-email.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { delegationError, revocationError } from './delegation-errors.js';
import { loadHierarchy } from './hierarchy.js';
import { resourceFor, scopeParents } from './scopes.js';

type GrantViewT = z.infer<typeof GrantView>;
type MemberT = z.infer<typeof Member>;
type RoleT = z.infer<typeof Role>;
type InvitationT = z.infer<typeof Invitation>;
type CreatedInvitationT = z.infer<typeof CreatedInvitation>;
type MembershipT = z.infer<typeof Membership>;
type RoleRow = typeof schema.roleDefinitions.$inferSelect;

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (value: string) => createHash('sha256').update(value).digest();
/** Conversation states that still need someone (the rest are finished). */
const OPEN_STATES = ['open', 'pending', 'snoozed'] as const;

/** A grant whose role has no permission at that level would do nothing; say so instead. */
function assertApplicable(patterns: readonly string[], scope: Scope) {
  if (!expandPatterns(patterns).some((p) => appliesAtScope(p, scope.type))) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'scope', message: 'This role has no permissions that apply at this level' }],
    });
  }
}

const isOwnerGrant = (patterns: readonly string[], scope: Scope) =>
  scope.type === 'tenant' && patterns.includes('*');

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

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

  private decisionOptions() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  private decide(principal: StaffPrincipal, permission: Permission, resource: ResourceScope = {}) {
    enforce(authorize(principal, permission, resource, this.decisionOptions()));
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
  private async ownersLeft(
    tx: TenantTx,
    change: { withoutGrant?: string; withoutMember?: string },
  ): Promise<number> {
    const owners = await tx
      .select({
        grantId: schema.grants.id,
        staffMemberId: schema.grants.staffMemberId,
        role: schema.roleDefinitions,
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
    return owners.filter(
      (o) =>
        rolePatterns(o.role).includes('*') &&
        o.grantId !== change.withoutGrant &&
        o.staffMemberId !== change.withoutMember,
    ).length;
  }

  private async assertOwnersRemain(
    tx: TenantTx,
    change: { withoutGrant?: string; withoutMember?: string },
  ) {
    if ((await this.ownersLeft(tx, change)) === 0) {
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

  /** Active grants of people, with the permissions their roles give now (for the ceiling). */
  private async heldGrants(
    tx: TenantTx,
    staffMemberIds: string[],
  ): Promise<Map<string, (HeldGrant & { grantId: string; roleId: string })[]>> {
    const result = new Map<string, (HeldGrant & { grantId: string; roleId: string })[]>();
    if (staffMemberIds.length === 0) return result;
    const rows = await tx
      .select({ grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(
        and(inArray(schema.grants.staffMemberId, staffMemberIds), isNull(schema.grants.revokedAt)),
      );
    const now = this.clock();
    for (const { grant, role } of rows) {
      if (!grant.staffMemberId || (grant.expiresAt && grant.expiresAt <= now)) continue;
      const list = result.get(grant.staffMemberId) ?? [];
      list.push({
        grantId: grant.id,
        roleId: role.id,
        permissions: rolePatterns(role),
        scope: scopeFromRow(grant.scopeType, grant.scopeId),
      });
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

  // ── Permission catalog ─────────────────────────────────────────────────────────────────────

  permissions(principal: StaffPrincipal): z.infer<typeof PermissionInfo>[] {
    const outside = new Set(unreachablePermissions(principal, PERMISSION_KEYS, this.clock()));
    return PERMISSION_KEYS.map((key) => {
      const spec = PERMISSIONS[key];
      return {
        key,
        description: spec.description,
        scopes: [...spec.scopes],
        stepUp: 'stepUp' in spec && spec.stepUp === true,
        mfa: 'mfa' in spec && spec.mfa === true,
        grantable: !outside.has(key),
      };
    });
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

  private async memberViews(
    tx: TenantTx,
    principal: StaffPrincipal,
    members: (typeof schema.staffMembers.$inferSelect)[],
  ): Promise<MemberT[]> {
    const ids = members.map((m) => m.id);
    const grants = await this.grantViews(tx, ids);
    const held = await this.heldGrants(tx, ids);
    const hierarchy = await loadHierarchy(tx);
    const teams = ids.length
      ? await tx
          .select({
            staffMemberId: schema.teamMembers.staffMemberId,
            id: schema.teams.id,
            name: schema.teams.name,
          })
          .from(schema.teamMembers)
          .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
          .where(inArray(schema.teamMembers.staffMemberId, ids))
          .orderBy(asc(schema.teams.name))
      : [];
    const now = this.clock();
    return members.map((m) => ({
      id: toPublicId('staff', m.id),
      displayName: m.displayName,
      email: m.email,
      status: m.status,
      grants: grants.get(m.id) ?? [],
      teams: teams
        .filter((t) => t.staffMemberId === m.id)
        .map((t) => ({ id: toPublicId('team', t.id), name: t.name })),
      lastActiveAt: iso(m.lastActiveAt),
      manageable:
        checkRevocation(
          principal,
          { staffMemberId: m.id, grants: held.get(m.id) ?? [] },
          hierarchy,
          now,
          'members.remove',
        ).length === 0,
    }));
  }

  async listMembers(principal: StaffPrincipal): Promise<MemberT[]> {
    return this.tx(principal, async (tx) => {
      const members = await tx
        .select()
        .from(schema.staffMembers)
        .where(ne(schema.staffMembers.status, 'removed'))
        .orderBy(asc(schema.staffMembers.displayName));
      return this.memberViews(tx, principal, members);
    });
  }

  /**
   * The ceiling for changing a person (A02, A03): their access must be within the actor's own,
   * and nobody changes themselves. Suspension and removal need `members.remove`.
   */
  private async assertCanManage(
    tx: TenantTx,
    principal: StaffPrincipal,
    staffMemberId: string,
    managePermission: Permission,
  ) {
    const held = (await this.heldGrants(tx, [staffMemberId])).get(staffMemberId) ?? [];
    const problems = checkRevocation(
      principal,
      { staffMemberId, grants: held },
      await loadHierarchy(tx),
      this.clock(),
      managePermission,
    );
    if (problems.length > 0) throw revocationError(problems);
  }

  private async lockMember(tx: TenantTx, staffMemberId: string) {
    const [member] = await tx
      .select()
      .from(schema.staffMembers)
      .where(eq(schema.staffMembers.id, staffMemberId))
      .for('update');
    if (!member || member.status === 'removed') throw new AppError('NOT_FOUND');
    return member;
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
    const member = await this.tx(principal, async (tx) => {
      const locked = await this.lockMember(tx, staffMemberId);
      await this.assertCanManage(tx, principal, staffMemberId, 'members.remove');
      if (input.status === 'suspended') {
        await this.assertOwnersRemain(tx, { withoutMember: staffMemberId });
      }
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
      return locked;
    });
    if (input.status === 'suspended')
      await this.endSessions(principal, member.authUserId, publicId);
    const members = await this.listMembers(principal);
    const updated = members.find((m) => m.id === publicId);
    if (!updated) throw new AppError('NOT_FOUND');
    return updated;
  }

  /** Ends the person's sessions once no access is left anywhere, and records it. */
  private async endSessions(principal: StaffPrincipal, authUserId: string, publicId: string) {
    try {
      const ended = await endSessionsIfNoAccessLeft(this.db, authUserId);
      if (ended > 0) {
        await this.tx(principal, (tx) =>
          this.audit(tx, principal, {
            action: 'member.sessions_ended',
            targetType: 'staff',
            targetId: publicId,
            data: { sessions: ended },
          }),
        );
      }
    } catch (error) {
      // Access already ended with the change; sessions expire on their own.
      this.logger.warn(`ending sessions failed: ${String(error)}`);
    }
  }

  /** What removing a person affects (HNV-22-05), before anything happens. */
  async offboarding(
    principal: StaffPrincipal,
    publicId: string,
  ): Promise<z.infer<typeof MemberOffboarding>> {
    const staffMemberId = this.parseId('staff', publicId);
    return this.tx(principal, async (tx) => {
      const [member] = await tx
        .select()
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, staffMemberId));
      if (!member || member.status === 'removed') throw new AppError('NOT_FOUND');
      const [view] = await this.memberViews(tx, principal, [member]);
      if (!view) throw new AppError('NOT_FOUND');
      const open = and(
        eq(schema.conversationControls.ownerStaffId, staffMemberId),
        inArray(schema.conversationControls.authorityStatus, [...OPEN_STATES]),
      );
      const [total] = await tx.select({ n: count() }).from(schema.conversationControls).where(open);
      const conversations = await tx
        .select({ id: schema.conversationControls.id })
        .from(schema.conversationControls)
        .where(open)
        .orderBy(asc(schema.conversationControls.lastActivityAt))
        .limit(50);
      return {
        member: view,
        openConversations: {
          total: Number(total?.n ?? 0),
          ids: conversations.map((c) => toPublicId('conversation', c.id)),
        },
        canReassign: authorizeAny(principal, 'conversations.bulk', this.decisionOptions()).allowed,
        lastOwner: (await this.ownersLeft(tx, { withoutMember: staffMemberId })) === 0,
      };
    });
  }

  /**
   * Removes a person (A02): every grant revoked, team places and pending invitations cleared, and
   * sessions ended when no other workspace keeps them. The next request and the next heartbeat of
   * any live stream find no membership, so access ends at once. History stays attributed.
   */
  async removeMember(
    principal: StaffPrincipal,
    publicId: string,
    reason: string | undefined,
  ): Promise<void> {
    const staffMemberId = this.parseId('staff', publicId);
    if (staffMemberId === principal.staffMemberId) {
      throw new AppError('VALIDATION_FAILED', { detail: "You can't remove yourself." });
    }
    const removed = await this.tx(principal, async (tx) => {
      const member = await this.lockMember(tx, staffMemberId);
      await this.assertCanManage(tx, principal, staffMemberId, 'members.remove');
      await this.assertOwnersRemain(tx, { withoutMember: staffMemberId });
      const now = this.clock();
      const grants = await tx
        .update(schema.grants)
        .set({ revokedAt: now, revokedBy: principal.staffMemberId })
        .where(and(eq(schema.grants.staffMemberId, staffMemberId), isNull(schema.grants.revokedAt)))
        .returning({ id: schema.grants.id });
      const teams = await tx
        .delete(schema.teamMembers)
        .where(eq(schema.teamMembers.staffMemberId, staffMemberId))
        .returning({ teamId: schema.teamMembers.teamId });
      const invitations = await tx
        .update(schema.invitations)
        .set({ status: 'revoked' })
        .where(
          and(eq(schema.invitations.email, member.email), eq(schema.invitations.status, 'pending')),
        )
        .returning({ id: schema.invitations.id });
      await tx
        .update(schema.staffMembers)
        .set({ status: 'removed' })
        .where(eq(schema.staffMembers.id, staffMemberId));
      await this.audit(tx, principal, {
        action: 'member.removed',
        targetType: 'staff',
        targetId: publicId,
        reason: reason ?? null,
        data: {
          grantsRevoked: grants.map((g) => toPublicId('grant', g.id)),
          teamsLeft: teams.map((t) => toPublicId('team', t.teamId)),
          invitationsRevoked: invitations.length,
        },
      });
      return member;
    });
    await this.endSessions(principal, removed.authUserId, publicId);
  }

  // ── Roles ──────────────────────────────────────────────────────────────────────────────────

  private roleView(row: RoleRow, holders: number, principal: StaffPrincipal): RoleT {
    const permissions = rolePatterns(row);
    return {
      id: toPublicId('role', row.id),
      key: row.key,
      name: row.name,
      description: row.description,
      permissions,
      isPreset: row.isPreset,
      version: row.version,
      memberCount: holders,
      editable:
        !row.isPreset &&
        unreachablePermissions(principal, expandPatterns(permissions), this.clock()).length === 0,
    };
  }

  private async holderCounts(tx: TenantTx): Promise<Map<string, number>> {
    const rows = await tx
      .selectDistinct({ roleId: schema.grants.roleId, staffMemberId: schema.grants.staffMemberId })
      .from(schema.grants)
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.grants.staffMemberId))
      .where(and(isNull(schema.grants.revokedAt), ne(schema.staffMembers.status, 'removed')));
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.roleId, (counts.get(row.roleId) ?? 0) + 1);
    return counts;
  }

  async listRoles(principal: StaffPrincipal): Promise<RoleT[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.roleDefinitions)
        .where(isNull(schema.roleDefinitions.archivedAt))
        .orderBy(asc(schema.roleDefinitions.isPreset), asc(schema.roleDefinitions.name));
      const holders = await this.holderCounts(tx);
      return rows.map((row) => this.roleView(row, holders.get(row.id) ?? 0, principal));
    });
  }

  /** Nobody can put a permission into a role that they don't hold across the whole tenant. */
  private assertHoldsTenantWide(principal: StaffPrincipal, permissions: Permission[]) {
    const missing = unreachablePermissions(principal, permissions, this.clock());
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
        return this.roleView(row, 0, principal);
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

  private async lockCustomRole(tx: TenantTx, principal: StaffPrincipal, roleId: string) {
    const [role] = await tx
      .select()
      .from(schema.roleDefinitions)
      .where(and(eq(schema.roleDefinitions.id, roleId), isNull(schema.roleDefinitions.archivedAt)))
      .for('update');
    if (!role) throw new AppError('NOT_FOUND');
    if (role.isPreset) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Built-in roles cannot be edited. Create a custom role instead.',
      });
    }
    // A role that reaches beyond the editor's own access is read-only to them (A12).
    this.assertHoldsTenantWide(principal, expandPatterns(role.permissions));
    return role;
  }

  async updateRole(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateRoleRequest>,
  ): Promise<RoleT> {
    const roleId = this.parseId('role', publicId);
    if (input.permissions) this.assertValidPatterns(input.permissions);
    return this.tx(principal, async (tx) => {
      const role = await this.lockCustomRole(tx, principal, roleId);
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
      const holders = await this.holderCounts(tx);
      return this.roleView(updated, holders.get(updated.id) ?? 0, principal);
    });
  }

  /** What saving would change (A12): the diff, what is out of reach, who gains or loses what. */
  async previewRole(
    principal: StaffPrincipal,
    input: z.output<typeof RolePreviewRequest>,
  ): Promise<z.infer<typeof RolePreview>> {
    // Previewing changes nothing: roles.manage is needed, a fresh sign-in only for saving.
    enforce(
      authorize(
        principal,
        'roles.manage',
        {},
        { now: this.clock(), stepUpMaxAgeMs: Number.POSITIVE_INFINITY },
      ),
    );
    this.assertValidPatterns(input.permissions);
    return this.tx(principal, async (tx) => {
      let role: RoleRow | undefined;
      if (input.roleId) {
        [role] = await tx
          .select()
          .from(schema.roleDefinitions)
          .where(
            and(
              eq(schema.roleDefinitions.id, this.parseId('role', input.roleId)),
              isNull(schema.roleDefinitions.archivedAt),
            ),
          );
        if (!role) throw new AppError('NOT_FOUND');
      }
      const before = role ? rolePatterns(role) : [];
      const diff = diffPermissions(before, input.permissions);
      const outsideReach = unreachablePermissions(
        principal,
        expandPatterns(input.permissions),
        this.clock(),
      );
      let impact: z.infer<typeof RolePreview>['impact'] = [];
      if (role) {
        const holders = await tx
          .selectDistinct({
            id: schema.staffMembers.id,
            displayName: schema.staffMembers.displayName,
          })
          .from(schema.grants)
          .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.grants.staffMemberId))
          .where(
            and(
              eq(schema.grants.roleId, role.id),
              isNull(schema.grants.revokedAt),
              ne(schema.staffMembers.status, 'removed'),
            ),
          )
          .orderBy(asc(schema.staffMembers.displayName));
        const held = await this.heldGrants(
          tx,
          holders.map((h) => h.id),
        );
        const names = new Map(holders.map((h) => [h.id, h.displayName]));
        impact = roleChangeImpact(
          holders.map((h) => ({ staffMemberId: h.id, grants: held.get(h.id) ?? [] })),
          role.id,
          input.permissions,
        ).map((entry) => ({
          staffMemberId: toPublicId('staff', entry.staffMemberId),
          displayName: names.get(entry.staffMemberId) ?? '',
          gains: entry.gains,
          loses: entry.loses,
        }));
      }
      return {
        added: diff.added,
        removed: diff.removed,
        addedSensitive: diff.addedSensitive,
        outsideReach,
        impact,
        version: role?.version ?? null,
      };
    });
  }

  /** Retires a custom role nobody holds; its name stays on past grants and in the audit log. */
  async archiveRole(principal: StaffPrincipal, publicId: string): Promise<void> {
    const roleId = this.parseId('role', publicId);
    await this.tx(principal, async (tx) => {
      const role = await this.lockCustomRole(tx, principal, roleId);
      const [held] = await tx
        .select({ n: count() })
        .from(schema.grants)
        .where(and(eq(schema.grants.roleId, roleId), isNull(schema.grants.revokedAt)));
      const [invited] = await tx
        .select({ n: count() })
        .from(schema.invitations)
        .where(
          and(eq(schema.invitations.roleId, roleId), eq(schema.invitations.status, 'pending')),
        );
      const [sso] = await tx
        .select({ n: count() })
        .from(schema.ssoConnections)
        .where(eq(schema.ssoConnections.jitRoleId, roleId));
      if (Number(held?.n) + Number(invited?.n) + Number(sso?.n) > 0) {
        throw new AppError('VALIDATION_FAILED', {
          detail:
            'People still hold or are invited with this role, or single sign-on gives it to new members. Change those first.',
        });
      }
      await tx
        .update(schema.roleDefinitions)
        .set({ archivedAt: this.clock(), version: role.version + 1 })
        .where(eq(schema.roleDefinitions.id, roleId));
      await this.audit(tx, principal, {
        action: 'role.archived',
        targetType: 'role',
        targetId: publicId,
        data: { key: role.key },
      });
    });
  }

  // ── Grants ─────────────────────────────────────────────────────────────────────────────────

  private async activeRole(tx: TenantTx, roleId: string) {
    const [role] = await tx
      .select()
      .from(schema.roleDefinitions)
      .where(and(eq(schema.roleDefinitions.id, roleId), isNull(schema.roleDefinitions.archivedAt)));
    return role;
  }

  /** The delegation ceiling for a new grant, with the scope's place in the tenant. */
  private async checkNewGrant(
    tx: TenantTx,
    principal: StaffPrincipal,
    grant: { staffMemberId: string; role: RoleRow; scope: Scope; expiresAt: Date | null },
  ) {
    const permissions = rolePatterns(grant.role);
    assertApplicable(permissions, grant.scope);
    const parents = await scopeParents(tx, grant.scope);
    const problems = checkDelegation(
      principal,
      {
        granteeStaffMemberId: grant.staffMemberId,
        permissions,
        scope: grant.scope,
        expiresAt: grant.expiresAt,
      },
      () => parents,
      this.clock(),
    );
    if (problems.length > 0) throw delegationError(problems);
    this.decide(principal, 'grants.manage', resourceFor(grant.scope, parents));
  }

  async createGrant(
    principal: StaffPrincipal,
    input: z.output<typeof CreateGrantRequest>,
  ): Promise<GrantViewT> {
    const staffMemberId = this.parseId('staff', input.staffMemberId);
    const roleId = this.parseId('role', input.roleId);
    const scope = scopeFromContract(input.scope);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    return this.tx(principal, async (tx) => {
      const role = await this.activeRole(tx, roleId);
      const [member] = await tx
        .select()
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, staffMemberId));
      if (!role || !member || member.status === 'removed') throw new AppError('NOT_FOUND');
      await this.checkNewGrant(tx, principal, { staffMemberId, role, scope, expiresAt });
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

  /** Loads an active grant for a change, and checks the actor could have given it (A02, A03). */
  private async lockGrantForChange(tx: TenantTx, principal: StaffPrincipal, grantId: string) {
    const [row] = await tx
      .select({ grant: schema.grants, role: schema.roleDefinitions })
      .from(schema.grants)
      .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.grants.roleId))
      .where(eq(schema.grants.id, grantId))
      .for('update', { of: schema.grants });
    if (!row) throw new AppError('NOT_FOUND');
    const scope: Scope = scopeFromRow(row.grant.scopeType, row.grant.scopeId);
    if (!row.grant.staffMemberId) throw new AppError('NOT_FOUND');
    if (row.grant.revokedAt) return { ...row, scope, active: false };
    this.decide(principal, 'grants.manage', resourceFor(scope, await scopeParents(tx, scope)));
    if (row.grant.staffMemberId === principal.staffMemberId) {
      throw new AppError('VALIDATION_FAILED', { detail: "You can't change your own access." });
    }
    const problems = checkRevocation(
      principal,
      {
        staffMemberId: row.grant.staffMemberId,
        grants: [{ permissions: rolePatterns(row.role), scope }],
      },
      await loadHierarchy(tx),
      this.clock(),
    );
    if (problems.length > 0) throw revocationError(problems);
    return { ...row, scope, active: true };
  }

  async revokeGrant(
    principal: StaffPrincipal,
    publicId: string,
    reason: string | undefined,
  ): Promise<void> {
    const grantId = this.parseId('grant', publicId);
    await this.tx(principal, async (tx) => {
      const { grant, active } = await this.lockGrantForChange(tx, principal, grantId);
      if (!active) return;
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

  /**
   * Changes someone's role, scope or expiry in one step (A02): the old grant is revoked and the new
   * one created in the same transaction, each within the actor's own access.
   */
  async replaceGrant(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ReplaceGrantRequest>,
  ): Promise<GrantViewT> {
    const grantId = this.parseId('grant', publicId);
    const roleId = this.parseId('role', input.roleId);
    const scope = scopeFromContract(input.scope);
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    return this.tx(principal, async (tx) => {
      const old = await this.lockGrantForChange(tx, principal, grantId);
      if (!old.active || !old.grant.staffMemberId) throw new AppError('NOT_FOUND');
      const staffMemberId = old.grant.staffMemberId;
      const role = await this.activeRole(tx, roleId);
      if (!role) throw new AppError('NOT_FOUND');
      await this.checkNewGrant(tx, principal, { staffMemberId, role, scope, expiresAt });
      const now = this.clock();
      await tx
        .update(schema.grants)
        .set({ revokedAt: now, revokedBy: principal.staffMemberId })
        .where(eq(schema.grants.id, grantId));
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
      if (!isOwnerGrant(rolePatterns(role), scope)) {
        await this.assertOwnersRemain(tx, { withoutGrant: grantId });
      }
      const view = this.grantView(grant, role);
      await this.audit(tx, principal, {
        action: 'grant.replaced',
        targetType: 'staff',
        targetId: toPublicId('staff', staffMemberId),
        reason: input.reason ?? null,
        data: {
          from: {
            grant: publicId,
            role: old.role.key,
            scope: scopeToContract(old.scope),
            expiresAt: iso(old.grant.expiresAt),
          },
          to: { grant: view.id, role: role.key, scope: view.scope, expiresAt: view.expiresAt },
        },
      });
      return view;
    });
  }

  // ── Invitations ────────────────────────────────────────────────────────────────────────────

  private invitationView(
    row: typeof schema.invitations.$inferSelect,
    role: typeof schema.roleDefinitions.$inferSelect,
    inviter: { id: string; displayName: string } | null,
  ): InvitationT {
    return {
      id: toPublicId('invitation', row.id),
      email: row.email,
      role: { id: toPublicId('role', role.id), key: role.key, name: role.name },
      scope: scopeToContract(scopeFromRow(row.scopeType, row.scopeId)),
      status: row.status,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      invitedBy: inviter
        ? { id: toPublicId('staff', inviter.id), displayName: inviter.displayName }
        : null,
      acceptedAt: iso(row.acceptedAt),
    };
  }

  private async inviter(tx: TenantTx, staffMemberId: string) {
    const [row] = await tx
      .select({ id: schema.staffMembers.id, displayName: schema.staffMembers.displayName })
      .from(schema.staffMembers)
      .where(eq(schema.staffMembers.id, staffMemberId));
    return row ?? null;
  }

  /** The invitation email (HTML and plain text), from the workspace's own sender name. */
  private async sendInvitation(principal: StaffPrincipal, created: InvitationT, token: string) {
    const { workspace, senderName } = await this.tx(principal, async (tx) => {
      const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
      return { workspace: tenant?.name ?? null, senderName: await senderNameOf(tx) };
    });
    await sendTemplate(
      this.mailer,
      { to: created.email, template: 'members.invitation', senderName },
      {
        kind: 'invitation',
        workspace,
        role: created.role.name,
        acceptUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/invitations/accept?token=${encodeURIComponent(token)}`,
        email: created.email,
        inviter: created.invitedBy?.displayName ?? null,
        days: Math.round(INVITATION_TTL_MS / 86_400_000),
      },
    );
  }

  private checkInvitationCeiling(
    principal: StaffPrincipal,
    invitationId: string,
    role: RoleRow,
    scope: Scope,
    parents: ResourceScope,
    grantExpiresAt: Date | null,
  ) {
    const permissions = rolePatterns(role);
    assertApplicable(permissions, scope);
    const problems = checkDelegation(
      principal,
      {
        granteeStaffMemberId: `invitation:${invitationId}`,
        permissions,
        scope,
        expiresAt: grantExpiresAt,
      },
      () => parents,
      this.clock(),
      'members.invite',
    );
    if (problems.length > 0) throw delegationError(problems);
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
      const role = await this.activeRole(tx, roleId);
      if (!role) throw new AppError('NOT_FOUND');
      const parents = await scopeParents(tx, scope);
      this.checkInvitationCeiling(principal, id, role, scope, parents, grantExpiresAt);
      const [existing] = await tx
        .select({ id: schema.staffMembers.id, status: schema.staffMembers.status })
        .from(schema.staffMembers)
        .where(
          and(
            eq(schema.staffMembers.email, input.email),
            inArray(schema.staffMembers.status, ['active', 'suspended']),
          ),
        );
      if (existing) {
        // A suspension is lifted by restoring the person (members.remove), never by an invitation.
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            {
              path: 'email',
              message:
                existing.status === 'suspended'
                  ? 'This person is suspended. Restore them from the member list instead.'
                  : 'Already a member',
            },
          ],
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
      const view = this.invitationView(row, role, await this.inviter(tx, principal.staffMemberId));
      await this.audit(tx, principal, {
        action: 'invitation.created',
        targetType: 'invitation',
        targetId: view.id,
        data: { email: input.email, role: role.key, scope: view.scope },
      });
      return view;
    });
    const token = `${created.id}.${secret}`;
    await this.sendInvitation(principal, created, token);
    return { ...created, token };
  }

  /**
   * Sends a pending (or expired) invitation again with a new link and a new week; the old link
   * stops working (HNV-22-02). The sender must be able to give the same access today.
   */
  async resendInvitation(principal: StaffPrincipal, publicId: string): Promise<CreatedInvitationT> {
    const invitationId = this.parseId('invitation', publicId);
    const secret = randomBytes(24).toString('base64url');
    const created = await this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.invitations)
        .where(eq(schema.invitations.id, invitationId))
        .for('update');
      if (row?.status !== 'pending') throw new AppError('NOT_FOUND');
      const role = await this.activeRole(tx, row.roleId);
      if (!role) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The role of this invitation was retired. Send a new invitation instead.',
        });
      }
      const scope = scopeFromRow(row.scopeType, row.scopeId);
      const parents = await scopeParents(tx, scope);
      this.checkInvitationCeiling(principal, row.id, role, scope, parents, row.grantExpiresAt);
      const [updated] = await tx
        .update(schema.invitations)
        .set({
          tokenHash: sha256(secret),
          expiresAt: new Date(this.clock().getTime() + INVITATION_TTL_MS),
        })
        .where(eq(schema.invitations.id, invitationId))
        .returning();
      if (!updated) throw new Error('invitation not returned');
      await this.audit(tx, principal, {
        action: 'invitation.resent',
        targetType: 'invitation',
        targetId: publicId,
        data: { email: updated.email },
      });
      return this.invitationView(updated, role, await this.inviter(tx, updated.invitedBy));
    });
    const token = `${created.id}.${secret}`;
    await this.sendInvitation(principal, created, token);
    return { ...created, token };
  }

  async listInvitations(principal: StaffPrincipal): Promise<InvitationT[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select({
          invitation: schema.invitations,
          role: schema.roleDefinitions,
          inviter: { id: schema.staffMembers.id, displayName: schema.staffMembers.displayName },
        })
        .from(schema.invitations)
        .innerJoin(schema.roleDefinitions, eq(schema.roleDefinitions.id, schema.invitations.roleId))
        .leftJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.invitations.invitedBy))
        .orderBy(asc(schema.invitations.createdAt));
      return rows.map(({ invitation, role, inviter }) =>
        this.invitationView(invitation, role, inviter?.id ? inviter : null),
      );
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
        if (!(await this.activeRole(tx, invitation.roleId))) {
          throw new AppError('NOT_FOUND', { detail: 'This invitation is no longer valid.' });
        }
        const [existing] = await tx
          .select()
          .from(schema.staffMembers)
          .where(eq(schema.staffMembers.authUserId, session.user.id));
        let staffMemberId = existing?.id;
        if (existing?.status === 'suspended') {
          // An invitation sent before the suspension does not lift it.
          throw new AppError('NOT_FOUND', { detail: 'This invitation is no longer valid.' });
        }
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
