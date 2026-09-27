import type { Brand, CreateBrandRequest, SetBusinessHoursRequest } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

export function brandView(row: typeof schema.brands.$inferSelect): Brand {
  return {
    id: toPublicId('brand', row.id),
    workspaceId: toPublicId('workspace', row.workspaceId),
    name: row.name,
    widgetId: row.widgetPublicId,
    allowedOrigins: row.allowedOrigins,
    businessHours: row.businessHours ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Brands and their widget IDs (board 04 foundations). */
@Injectable()
export class BrandsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private allowed(principal: StaffPrincipal, permission: Permission, resource: object) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  async list(principal: StaffPrincipal): Promise<Brand[]> {
    const rows = await this.tx(principal, (tx) =>
      tx.select().from(schema.brands).orderBy(asc(schema.brands.createdAt)),
    );
    return rows
      .filter(
        (row) =>
          this.allowed(principal, 'brands.manage', {
            workspaceId: row.workspaceId,
            brandId: row.id,
          }).allowed,
      )
      .map(brandView);
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateBrandRequest>,
  ): Promise<Brand> {
    const workspaceId = fromPublicId('workspace', input.workspaceId);
    return this.tx(principal, async (tx) => {
      const [workspace] = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.id, workspaceId));
      if (!workspace) throw new AppError('NOT_FOUND', { detail: 'Workspace not found.' });
      enforce(this.allowed(principal, 'brands.manage', { workspaceId }));
      const [row] = await tx
        .insert(schema.brands)
        .values({
          tenantId: principal.tenantId,
          workspaceId,
          name: input.name,
          widgetPublicId: toPublicId('widget', newId()),
          allowedOrigins: [...new Set(input.allowedOrigins)],
        })
        .returning();
      if (!row) throw new Error('brand insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.created',
        targetType: 'brand',
        targetId: toPublicId('brand', row.id),
        outcome: 'success',
        data: { name: row.name, allowedOrigins: row.allowedOrigins },
      });
      return brandView(row);
    });
  }

  /** Sets or removes the hours when people answer (W11); the widget picks them up at once. */
  async setBusinessHours(
    principal: StaffPrincipal,
    brandPublicId: string,
    businessHours: z.output<typeof SetBusinessHoursRequest>['businessHours'],
  ): Promise<Brand> {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'widget.configure', {
          workspaceId: brand.workspaceId,
          brandId: brand.id,
        }),
      );
      const [row] = await tx
        .update(schema.brands)
        .set({
          businessHours,
          configVersion: brand.configVersion + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.brands.id, brandId))
        .returning();
      if (!row) throw new Error('brand update returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.business_hours.updated',
        targetType: 'brand',
        targetId: toPublicId('brand', brand.id),
        outcome: 'success',
        data: { timezone: businessHours?.timezone ?? null },
      });
      return brandView(row);
    });
  }
}
