import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  authorize,
  type Decision,
  grantsPermission,
  isGrantActive,
  type Permission,
  type ResourceScope,
  type StaffPrincipal,
} from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { ControlRow } from '../authority/ownership.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

/** Where a staff member's grants for one permission reach. */
export interface VisibleScope {
  all: boolean;
  workspaceIds: string[];
  brandIds: string[];
  inboxIds: string[];
  teamIds: string[];
}

/** Where a conversation lives for authorization: its workspace, brand, inbox and team. */
export function resourceOf(
  control: { brandId: string | null; inboxId: string },
  workspaceId: string | null,
  teamId: string | null,
): ResourceScope {
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(control.brandId ? { brandId: control.brandId } : {}),
    inboxId: control.inboxId,
    ...(teamId ? { teamId } : {}),
  };
}

/** A conversation loaded for a staff action, with where it lives for authorization. */
export interface ConversationAccess {
  control: ControlRow;
  resource: ResourceScope;
  workspaceId: string | null;
  teamId: string | null;
}

/**
 * Staff access to conversations. A conversation is visible when a `conversations.read` grant covers
 * its workspace, brand, inbox or team; outside that it does not exist for the caller (NOT_FOUND),
 * and inside it a missing permission for one action is SCOPE_DENIED with the reason.
 */
@Injectable()
export class InboxAccess {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private options() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  decide(principal: StaffPrincipal, permission: Permission, resource: ResourceScope): Decision {
    return authorize(principal, permission, resource, this.options());
  }

  can(principal: StaffPrincipal, permission: Permission, resource: ResourceScope): boolean {
    return this.decide(principal, permission, resource).allowed;
  }

  /** Where the principal's grants for `permission` reach, or null when nowhere. */
  scope(
    principal: StaffPrincipal,
    permission: Permission = 'conversations.read',
  ): VisibleScope | null {
    if (principal.status !== 'active') return null;
    const now = this.clock();
    const scope: VisibleScope = {
      all: false,
      workspaceIds: [],
      brandIds: [],
      inboxIds: [],
      teamIds: [],
    };
    for (const grant of principal.grants) {
      if (!isGrantActive(grant, now) || !grantsPermission(grant, permission)) continue;
      switch (grant.scope.type) {
        case 'tenant':
          scope.all = true;
          break;
        case 'workspace':
          scope.workspaceIds.push(grant.scope.id);
          break;
        case 'brand':
          scope.brandIds.push(grant.scope.id);
          break;
        case 'inbox':
          scope.inboxIds.push(grant.scope.id);
          break;
        case 'team':
          scope.teamIds.push(grant.scope.id);
          break;
      }
    }
    const some =
      scope.workspaceIds.length +
      scope.brandIds.length +
      scope.inboxIds.length +
      scope.teamIds.length;
    return scope.all || some > 0 ? scope : null;
  }

  /**
   * The SQL condition for a visible scope, over conversation_controls joined with brands and
   * conversation_inbox_state (undefined: everything in the tenant).
   */
  static condition(scope: VisibleScope): SQL | undefined {
    if (scope.all) return undefined;
    const c = schema.conversationControls;
    const parts: SQL[] = [];
    if (scope.workspaceIds.length)
      parts.push(inArray(schema.brands.workspaceId, scope.workspaceIds));
    if (scope.brandIds.length) parts.push(inArray(c.brandId, scope.brandIds));
    if (scope.inboxIds.length) parts.push(inArray(c.inboxId, scope.inboxIds));
    if (scope.teamIds.length) {
      parts.push(inArray(schema.conversationInboxState.teamId, scope.teamIds));
    }
    return or(...parts) ?? sql`false`;
  }

  /** Loads a conversation by its public id with its workspace and team (no permission check). */
  async load(tx: TenantTx, publicId: string, lock = false): Promise<ConversationAccess | null> {
    const id = fromPublicId('conversation', publicId);
    const query = tx
      .select({
        control: schema.conversationControls,
        workspaceId: schema.brands.workspaceId,
        teamId: schema.conversationInboxState.teamId,
      })
      .from(schema.conversationControls)
      .leftJoin(schema.brands, eq(schema.brands.id, schema.conversationControls.brandId))
      .leftJoin(
        schema.conversationInboxState,
        eq(schema.conversationInboxState.conversationId, schema.conversationControls.id),
      )
      .where(eq(schema.conversationControls.id, id));
    const [row] = lock
      ? await query.for('update', { of: schema.conversationControls })
      : await query;
    if (!row) return null;
    const { control, workspaceId, teamId } = row;
    return {
      control,
      workspaceId,
      teamId,
      resource: resourceOf(control, workspaceId, teamId),
    };
  }

  /**
   * A conversation the principal may use `permission` on. Not visible at all → NOT_FOUND (it does
   * not exist for them); visible but not allowed → SCOPE_DENIED, MFA or step-up as policy says.
   */
  async authorized(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
    lock = false,
  ): Promise<ConversationAccess> {
    const found = await this.load(tx, publicId, lock);
    const notFound = () => new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    if (!found) throw notFound();
    if (!this.can(principal, 'conversations.read', found.resource)) throw notFound();
    enforce(this.decide(principal, permission, found.resource));
    return found;
  }
}
