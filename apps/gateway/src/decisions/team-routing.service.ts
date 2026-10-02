import type { RoutingTeam, SetTeamRoutingRequest } from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { authorizedBrand, type BrandRow, idOf } from './access.js';
import { routingTeamView } from './views.js';

export type TeamRow = typeof schema.teams.$inferSelect;
export type TeamRoutingRow = typeof schema.teamRouting.$inferSelect;

/** Active inbox teams that may take a brand's conversations: its workspace's, or tenant-wide. */
export function teamsForBrand(tx: TenantTx, brand: Pick<BrandRow, 'id' | 'workspaceId'>) {
  return tx
    .select({ team: schema.teams, routing: schema.teamRouting })
    .from(schema.teams)
    .leftJoin(
      schema.teamRouting,
      and(eq(schema.teamRouting.teamId, schema.teams.id), eq(schema.teamRouting.brandId, brand.id)),
    )
    .where(
      and(
        eq(schema.teams.status, 'active'),
        or(isNull(schema.teams.workspaceId), eq(schema.teams.workspaceId, brand.workspaceId)),
      ),
    )
    .orderBy(asc(schema.teams.name));
}

/**
 * How the inbox's teams take part in a brand's routing (J02, U07). Teams, their members and their
 * Chatwoot teams belong to the inbox (`/v1/admin/teams`); this keeps, per brand, the intents each
 * team handles, its languages and whether it is the default or accepting conversations. Reading
 * needs `decisions.read`, changing `decisions.manage`; changes are audited.
 */
@Injectable()
export class TeamRoutingService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private get access() {
    return { now: this.clock(), config: this.config };
  }

  async list(principal: StaffPrincipal, brandPublicId: string): Promise<RoutingTeam[]> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.read',
        this.access,
      );
      const rows = await teamsForBrand(tx, brand);
      return rows.map((row) => routingTeamView(row.team, brand.id, row.routing));
    });
  }

  async set(
    principal: StaffPrincipal,
    brandPublicId: string,
    teamPublicId: string,
    input: z.output<typeof SetTeamRoutingRequest>,
  ): Promise<RoutingTeam> {
    const teamId = idOf('team', teamPublicId, 'Team');
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'decisions.manage',
        this.access,
      );
      const [team] = await tx.select().from(schema.teams).where(eq(schema.teams.id, teamId));
      if (!team) throw new AppError('NOT_FOUND', { detail: 'Team not found.' });
      if (
        team.status !== 'active' ||
        (team.workspaceId !== null && team.workspaceId !== brand.workspaceId)
      ) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            { path: 'teamId', message: 'This team cannot take this brand’s conversations.' },
          ],
        });
      }
      const values = {
        intents: [...new Set(input.intents)],
        languages: [...new Set(input.languages)],
        translationLanguages: [...new Set(input.translationLanguages)],
        isDefault: input.isDefault,
        accepting: input.accepting,
        status: input.status,
        updatedBy: principal.staffMemberId,
        updatedAt: this.clock(),
      };
      const [before] = await tx
        .select()
        .from(schema.teamRouting)
        .where(
          and(eq(schema.teamRouting.teamId, team.id), eq(schema.teamRouting.brandId, brand.id)),
        );
      const [routing] = await tx
        .insert(schema.teamRouting)
        .values({ tenantId: principal.tenantId, teamId: team.id, brandId: brand.id, ...values })
        .onConflictDoUpdate({
          target: [
            schema.teamRouting.tenantId,
            schema.teamRouting.teamId,
            schema.teamRouting.brandId,
          ],
          set: values,
        })
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'team.routing_changed',
        targetType: 'team',
        targetId: teamPublicId,
        outcome: 'success',
        data: {
          brand: brandPublicId,
          intents: values.intents,
          languages: values.languages,
          translationLanguages: values.translationLanguages,
          isDefault: values.isDefault,
          accepting: values.accepting,
          status: values.status,
          created: !before,
        },
      });
      return routingTeamView(team, brand.id, routing ?? null);
    });
  }
}
