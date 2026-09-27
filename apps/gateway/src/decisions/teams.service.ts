import type {
  CreateRoutingTeamRequest,
  RoutingTeam,
  UpdateRoutingTeamRequest,
} from '@hamnivo/contracts';
import { appendAudit, type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { isUniqueViolation } from '../common/pg-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { authorizedBrand, authorizedBrandById, idOf } from './access.js';
import { teamView } from './views.js';

/**
 * Routing teams of a brand (J02, U07): the intents and languages each team handles. Changing them
 * is an inbox setting (`inbox.manage`), audited; reading them needs `decisions.read`.
 */
@Injectable()
export class TeamsService {
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
      const rows = await tx
        .select()
        .from(schema.routingTeams)
        .where(eq(schema.routingTeams.brandId, brand.id))
        .orderBy(asc(schema.routingTeams.createdAt));
      return rows.map(teamView);
    });
  }

  async create(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof CreateRoutingTeamRequest>,
  ): Promise<RoutingTeam> {
    return this.tx(principal, async (tx) => {
      const brand = await authorizedBrand(
        tx,
        principal,
        brandPublicId,
        'inbox.manage',
        this.access,
      );
      let row: typeof schema.routingTeams.$inferSelect | undefined;
      try {
        [row] = await tx
          .insert(schema.routingTeams)
          .values({
            tenantId: principal.tenantId,
            brandId: brand.id,
            name: input.name,
            intents: [...new Set(input.intents)],
            languages: [...new Set(input.languages)],
            translationLanguages: [...new Set(input.translationLanguages)],
            externalTeamId: input.externalTeamId ?? null,
            isDefault: input.isDefault,
            accepting: input.accepting,
            createdBy: principal.staffMemberId,
          })
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError('VALIDATION_FAILED', {
            fields: [{ path: 'name', message: 'This brand already has a team with this name.' }],
          });
        }
        throw error;
      }
      if (!row) throw new Error('routing team insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'routing.team.created',
        targetType: 'team',
        targetId: toPublicId('team', row.id),
        outcome: 'success',
        data: {
          brand: brandPublicId,
          intents: row.intents,
          languages: row.languages,
          translationLanguages: row.translationLanguages,
          isDefault: row.isDefault,
        },
      });
      return teamView(row);
    });
  }

  async update(
    principal: StaffPrincipal,
    teamPublicId: string,
    input: z.output<typeof UpdateRoutingTeamRequest>,
  ): Promise<RoutingTeam> {
    const teamId = idOf('team', teamPublicId, 'Team');
    return this.tx(principal, async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.routingTeams)
        .where(eq(schema.routingTeams.id, teamId))
        .for('update');
      if (!current) throw new AppError('NOT_FOUND', { detail: 'Team not found.' });
      await authorizedBrandById(tx, principal, current.brandId, 'inbox.manage', this.access);
      const changes = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.intents ? { intents: [...new Set(input.intents)] } : {}),
        ...(input.languages ? { languages: [...new Set(input.languages)] } : {}),
        ...(input.translationLanguages
          ? { translationLanguages: [...new Set(input.translationLanguages)] }
          : {}),
        ...(input.externalTeamId !== undefined ? { externalTeamId: input.externalTeamId } : {}),
        ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
        ...(input.accepting !== undefined ? { accepting: input.accepting } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updatedAt: this.clock(),
      };
      const [row] = await tx
        .update(schema.routingTeams)
        .set(changes)
        .where(eq(schema.routingTeams.id, teamId))
        .returning();
      if (!row) throw new Error('routing team update returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'routing.team.updated',
        targetType: 'team',
        targetId: teamPublicId,
        outcome: 'success',
        data: { changed: Object.keys(changes).filter((k) => k !== 'updatedAt') },
      });
      return teamView(row);
    });
  }
}
