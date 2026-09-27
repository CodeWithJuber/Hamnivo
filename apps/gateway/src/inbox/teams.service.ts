import type { CreateTeamRequest, Team } from '@hamnivo/contracts';
import { appendAudit, fromPublicId, schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from './access.js';

type TeamRow = typeof schema.teams.$inferSelect;

/**
 * Teams (H02): groups of staff that conversations can be assigned to, and a scope for grants.
 * Each team becomes a Chatwoot team in an account the first time a conversation there is given
 * to it. Managing teams needs `teams.manage` at the team's workspace (or tenant) level.
 */
@Injectable()
export class TeamsService {
  constructor(private readonly access: InboxAccess) {}

  private async view(tx: TenantTx, rows: TeamRow[]): Promise<Team[]> {
    if (rows.length === 0) return [];
    const members = await tx
      .select({
        teamId: schema.teamMembers.teamId,
        staffMemberId: schema.staffMembers.id,
        displayName: schema.staffMembers.displayName,
      })
      .from(schema.teamMembers)
      .innerJoin(schema.staffMembers, eq(schema.staffMembers.id, schema.teamMembers.staffMemberId))
      .where(
        inArray(
          schema.teamMembers.teamId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(schema.staffMembers.displayName));
    return rows.map((row) => ({
      id: toPublicId('team', row.id),
      name: row.name,
      workspaceId: row.workspaceId ? toPublicId('workspace', row.workspaceId) : null,
      status: row.status,
      members: members
        .filter((m) => m.teamId === row.id)
        .map((m) => ({
          staffMemberId: toPublicId('staff', m.staffMemberId),
          displayName: m.displayName,
        })),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async list(principal: StaffPrincipal): Promise<Team[]> {
    return this.access.tx(principal, async (tx) =>
      this.view(tx, await tx.select().from(schema.teams).orderBy(asc(schema.teams.name))),
    );
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateTeamRequest>,
  ): Promise<Team> {
    const workspaceId = input.workspaceId ? fromPublicId('workspace', input.workspaceId) : null;
    return this.access.tx(principal, async (tx) => {
      if (workspaceId) {
        const [workspace] = await tx
          .select({ id: schema.workspaces.id })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, workspaceId));
        if (!workspace) throw new AppError('NOT_FOUND', { detail: 'Workspace not found.' });
      }
      enforce(this.access.decide(principal, 'teams.manage', workspaceId ? { workspaceId } : {}));
      let row: TeamRow | undefined;
      try {
        [row] = await tx.transaction((sp) =>
          sp
            .insert(schema.teams)
            .values({
              tenantId: principal.tenantId,
              workspaceId,
              name: input.name,
              createdBy: principal.staffMemberId,
            })
            .returning(),
        );
      } catch (error) {
        if (isUniqueViolation(error, 'teams_name_key')) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'name', message: 'A team with this name already exists.' }],
          });
        }
        throw error;
      }
      if (!row) throw new Error('team insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'team.created',
        targetType: 'team',
        targetId: toPublicId('team', row.id),
        outcome: 'success',
        data: { name: row.name },
      });
      const [team] = await this.view(tx, [row]);
      return team as Team;
    });
  }

  async setMembers(
    principal: StaffPrincipal,
    teamPublicId: string,
    staffPublicIds: string[],
  ): Promise<Team> {
    const teamId = fromPublicId('team', teamPublicId);
    const wanted = [...new Set(staffPublicIds.map((id) => fromPublicId('staff', id)))];
    return this.access.tx(principal, async (tx) => {
      const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      if (!team) throw new AppError('NOT_FOUND', { detail: 'Team not found.' });
      enforce(
        this.access.decide(
          principal,
          'teams.manage',
          team.workspaceId ? { workspaceId: team.workspaceId, teamId } : { teamId },
        ),
      );
      const staff = wanted.length
        ? await tx
            .select({ id: schema.staffMembers.id })
            .from(schema.staffMembers)
            .where(
              and(
                inArray(schema.staffMembers.id, wanted),
                eq(schema.staffMembers.status, 'active'),
              ),
            )
        : [];
      if (staff.length !== wanted.length) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'staffMemberIds', message: 'Only active staff members can join.' }],
        });
      }
      const current = await tx
        .select({ staffMemberId: schema.teamMembers.staffMemberId })
        .from(schema.teamMembers)
        .where(eq(schema.teamMembers.teamId, teamId));
      const had = new Set(current.map((m) => m.staffMemberId));
      const removed = [...had].filter((id) => !wanted.includes(id));
      const added = wanted.filter((id) => !had.has(id));
      if (removed.length) {
        await tx
          .delete(schema.teamMembers)
          .where(
            and(
              eq(schema.teamMembers.teamId, teamId),
              inArray(schema.teamMembers.staffMemberId, removed),
            ),
          );
      }
      if (added.length) {
        await tx
          .insert(schema.teamMembers)
          .values(
            added.map((staffMemberId) => ({ tenantId: principal.tenantId, teamId, staffMemberId })),
          );
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'team.members_changed',
        targetType: 'team',
        targetId: teamPublicId,
        outcome: 'success',
        data: {
          added: added.map((id) => toPublicId('staff', id)),
          removed: removed.map((id) => toPublicId('staff', id)),
        },
      });
      const [view] = await this.view(tx, [team]);
      return view as Team;
    });
  }
}
