import type { CreateKillSwitchRequest, KillSwitch } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { iso } from '../common/views.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type Row = typeof schema.killSwitches.$inferSelect;

function view(row: Row): KillSwitch {
  return {
    id: toPublicId('killSwitch', row.id),
    scope: row.scope,
    targetId: row.agentId
      ? toPublicId('agent', row.agentId)
      : row.brandId
        ? toPublicId('brand', row.brandId)
        : null,
    reason: row.reason,
    active: row.clearedAt === null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy ? toPublicId('staff', row.createdBy) : null,
    clearedAt: iso(row.clearedAt),
  };
}

/**
 * Kill switches (X08): stop AI replies for the tenant, a brand or one agent. Conversations the AI
 * held go to people on their next message; staff messaging keeps working throughout.
 */
@Injectable()
export class KillSwitchesService {
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

  private allowed(
    principal: StaffPrincipal,
    permission: Permission,
    resource: { workspaceId?: string; brandId?: string },
  ) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  /** The resource a switch acts on, for authorization: the brand, or the whole tenant. */
  private async resourceOf(tx: TenantTx, row: Pick<Row, 'brandId' | 'agentId'>) {
    if (row.agentId) {
      const [agent] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(eq(schema.agentProfiles.id, row.agentId));
      if (!agent) throw new AppError('NOT_FOUND', { detail: 'Agent not found.' });
      return { workspaceId: agent.workspaceId, brandId: agent.brandId };
    }
    if (row.brandId) {
      const [brand] = await tx
        .select()
        .from(schema.brands)
        .where(eq(schema.brands.id, row.brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      return { workspaceId: brand.workspaceId, brandId: brand.id };
    }
    return {};
  }

  async list(principal: StaffPrincipal): Promise<KillSwitch[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.killSwitches)
        .orderBy(desc(schema.killSwitches.createdAt))
        .limit(200);
      const visible: KillSwitch[] = [];
      for (const row of rows) {
        if (this.allowed(principal, 'agents.read', await this.resourceOf(tx, row)).allowed) {
          visible.push(view(row));
        }
      }
      return visible;
    });
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateKillSwitchRequest>,
  ): Promise<KillSwitch> {
    const target = {
      brandId: input.scope === 'brand' ? fromPublicId('brand', input.targetId ?? '') : null,
      agentId: input.scope === 'agent' ? fromPublicId('agent', input.targetId ?? '') : null,
    };
    return this.tx(principal, async (tx) => {
      enforce(this.allowed(principal, 'agents.publish', await this.resourceOf(tx, target)));
      const [row] = await tx
        .insert(schema.killSwitches)
        .values({
          tenantId: principal.tenantId,
          scope: input.scope,
          ...target,
          reason: input.reason,
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!row) throw new Error('kill switch insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'ai.kill_switch.activated',
        targetType: 'kill_switch',
        targetId: toPublicId('killSwitch', row.id),
        outcome: 'success',
        data: { scope: row.scope, target: view(row).targetId, reason: row.reason },
      });
      return view(row);
    });
  }

  async clear(principal: StaffPrincipal, publicId: string): Promise<KillSwitch> {
    return this.tx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.killSwitches)
        .where(eq(schema.killSwitches.id, fromPublicId('killSwitch', publicId)))
        .for('update');
      if (!row) throw new AppError('NOT_FOUND', { detail: 'Kill switch not found.' });
      enforce(this.allowed(principal, 'agents.publish', await this.resourceOf(tx, row)));
      if (row.clearedAt) return view(row);
      const [cleared] = await tx
        .update(schema.killSwitches)
        .set({ clearedAt: this.clock(), clearedBy: principal.staffMemberId })
        .where(eq(schema.killSwitches.id, row.id))
        .returning();
      if (!cleared) throw new Error('kill switch update returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'ai.kill_switch.cleared',
        targetType: 'kill_switch',
        targetId: publicId,
        outcome: 'success',
        data: { scope: row.scope, target: view(row).targetId },
      });
      return view(cleared);
    });
  }

  /** The active switch that stops this brand's agent, if any. */
  async activeFor(
    tx: TenantTx,
    scope: { brandId: string | null; agentId: string | null },
  ): Promise<Row | null> {
    const [row] = await tx
      .select()
      .from(schema.killSwitches)
      .where(
        and(
          isNull(schema.killSwitches.clearedAt),
          or(
            eq(schema.killSwitches.scope, 'tenant'),
            scope.brandId ? eq(schema.killSwitches.brandId, scope.brandId) : undefined,
            scope.agentId ? eq(schema.killSwitches.agentId, scope.agentId) : undefined,
          ),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}
