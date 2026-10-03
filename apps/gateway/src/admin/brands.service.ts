import type {
  Brand,
  CreateBrandRequest,
  SetBusinessHoursRequest,
  UpdateBrandRequest,
} from '@hamnivo/contracts';
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
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import { queueFirstBrandSetup } from '../authority/provisioning.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { originAllowed, sessionOrigin } from '../widget/origins.js';

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
      // The workspace's first brand gets its Chatwoot account by itself (SaaS onboarding).
      await queueFirstBrandSetup(tx, this.config, principal.tenantId, row.id, this.clock());
      return brandView(row);
    });
  }

  /** The brand, locked for the change, once the caller may make it. */
  private async lockBrand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
    permission: Permission,
  ) {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId))
      .for('update');
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    enforce(this.allowed(principal, permission, { workspaceId: brand.workspaceId, brandId }));
    return brand;
  }

  /**
   * Renames a brand or replaces its allowed websites (board 04). Chats open on a website that is
   * no longer allowed end at once: their sessions are revoked, and the widget there stops loading.
   */
  async update(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: z.output<typeof UpdateBrandRequest>,
  ): Promise<Brand> {
    return this.tx(principal, async (tx) => {
      const brand = await this.lockBrand(tx, principal, brandPublicId, 'brands.manage');
      const name = input.name ?? brand.name;
      const origins =
        input.allowedOrigins === undefined
          ? brand.allowedOrigins
          : [...new Set(input.allowedOrigins)];
      const added = origins.filter((origin) => !brand.allowedOrigins.includes(origin));
      const removed = brand.allowedOrigins.filter((origin) => !origins.includes(origin));
      const originsChanged = added.length > 0 || removed.length > 0;
      if (name === brand.name && !originsChanged) return brandView(brand);
      const now = this.clock();
      const [row] = await tx
        .update(schema.brands)
        .set({
          name,
          allowedOrigins: originsChanged ? origins : brand.allowedOrigins,
          configVersion: brand.configVersion + 1,
          updatedAt: now,
        })
        .where(eq(schema.brands.id, brand.id))
        .returning();
      if (!row) throw new Error('brand update returned nothing');

      const open = and(
        eq(schema.widgetSessions.brandId, brand.id),
        isNull(schema.widgetSessions.revokedAt),
      );
      const pages = await tx
        .selectDistinct({ hostOrigin: schema.widgetSessions.hostOrigin })
        .from(schema.widgetSessions)
        .where(open);
      const refused = pages
        .map((page) => page.hostOrigin)
        .filter((stored) => !originAllowed(origins, sessionOrigin(stored)));
      const ended =
        refused.length === 0
          ? []
          : await tx
              .update(schema.widgetSessions)
              .set({ revokedAt: now, revokeReason: 'origin_removed' })
              .where(and(open, inArray(schema.widgetSessions.hostOrigin, refused)))
              .returning({ id: schema.widgetSessions.id });

      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.updated',
        targetType: 'brand',
        targetId: toPublicId('brand', brand.id),
        outcome: 'success',
        data: {
          ...(name === brand.name ? {} : { name: { from: brand.name, to: name } }),
          ...(originsChanged ? { allowedOrigins: { added, removed } } : {}),
          endedSessions: ended.length,
        },
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
    return this.tx(principal, async (tx) => {
      const brand = await this.lockBrand(tx, principal, brandPublicId, 'widget.configure');
      const [row] = await tx
        .update(schema.brands)
        .set({
          businessHours,
          configVersion: brand.configVersion + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.brands.id, brand.id))
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
