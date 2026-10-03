import {
  ProactiveSettings,
  type ProactiveSettingsView,
  type WidgetAppearance,
  WidgetSettings,
  type WidgetSettingsView,
} from '@hamnivo/contracts';
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
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { parseAppearance } from './appearance.js';

export interface BrandSurface {
  settings: WidgetSettings;
  proactive: ProactiveSettings;
  /** How the chat looks and what it says (W03); the defaults when left out. */
  appearance?: WidgetAppearance;
  settingsUpdatedAt: Date | null;
  proactiveUpdatedAt: Date | null;
}

/** Stored settings, or the contract's defaults when there are none or they no longer parse. */
function parsed<T>(schemaOf: z.ZodType<T>, value: unknown): T {
  const result = schemaOf.safeParse(value ?? {});
  return result.success ? result.data : schemaOf.parse({});
}

/** A brand's widget settings, proactive prompts and appearance (defaults when it has none). */
export async function brandSurface(tx: TenantTx, brandId: string): Promise<BrandSurface> {
  const [row] = await tx
    .select()
    .from(schema.brandWidgetSettings)
    .where(eq(schema.brandWidgetSettings.brandId, brandId));
  const [look] = await tx
    .select({ appearance: schema.brandAppearance.appearance })
    .from(schema.brandAppearance)
    .where(eq(schema.brandAppearance.brandId, brandId));
  return {
    settings: parsed(WidgetSettings, row?.settings),
    proactive: parsed(ProactiveSettings, row?.proactive),
    appearance: parseAppearance(look?.appearance),
    settingsUpdatedAt: row?.settingsUpdatedAt ?? null,
    proactiveUpdatedAt: row?.proactiveUpdatedAt ?? null,
  };
}

/**
 * Brand settings for the customer surface (Studio and the admin API): the widget's layout,
 * files, help home, deletion window and email offers need widget.configure; proactive prompts
 * have their own permission, widget.proactive (W19). Each change is audited and publishes a new
 * configuration version, which the widget and the loader pick up at once.
 */
@Injectable()
export class WidgetSettingsService {
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

  /** The brand, locked when it changes, once the caller may act on it. */
  private async brand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
    permission: Permission,
    lock: boolean,
  ) {
    let brandId: string;
    try {
      brandId = fromPublicId('brand', brandPublicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const query = tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
    const [brand] = lock ? await query.for('update') : await query;
    if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    enforce(
      authorize(
        principal,
        permission,
        { workspaceId: brand.workspaceId, brandId },
        {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        },
      ),
    );
    return brand;
  }

  /** Writes one column of the brand's settings row and publishes a new configuration version. */
  private async save(
    tx: TenantTx,
    brand: typeof schema.brands.$inferSelect,
    change: { settings: WidgetSettings } | { proactive: ProactiveSettings },
  ): Promise<number> {
    const now = this.clock();
    const values =
      'settings' in change
        ? { settings: change.settings, settingsUpdatedAt: now }
        : { proactive: change.proactive, proactiveUpdatedAt: now };
    await tx
      .insert(schema.brandWidgetSettings)
      .values({ tenantId: brand.tenantId, brandId: brand.id, ...values })
      .onConflictDoUpdate({
        target: [schema.brandWidgetSettings.tenantId, schema.brandWidgetSettings.brandId],
        set: { ...values, updatedAt: now },
      });
    const version = brand.configVersion + 1;
    await tx
      .update(schema.brands)
      .set({ configVersion: version, updatedAt: now })
      .where(and(eq(schema.brands.id, brand.id)));
    return version;
  }

  async getSettings(principal: StaffPrincipal, brandId: string): Promise<WidgetSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', false);
      const surface = await brandSurface(tx, brand.id);
      return { brandId, settings: surface.settings, configVersion: brand.configVersion };
    });
  }

  async updateSettings(
    principal: StaffPrincipal,
    brandId: string,
    settings: WidgetSettings,
  ): Promise<WidgetSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', true);
      const before = (await brandSurface(tx, brand.id)).settings;
      const version = await this.save(tx, brand, { settings });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.widget_settings.updated',
        targetType: 'brand',
        targetId: brandId,
        outcome: 'success',
        data: { before, after: settings },
      });
      return { brandId, settings, configVersion: version };
    });
  }

  async getProactive(principal: StaffPrincipal, brandId: string): Promise<ProactiveSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.proactive', false);
      const surface = await brandSurface(tx, brand.id);
      return {
        brandId,
        settings: surface.proactive,
        updatedAt: surface.proactiveUpdatedAt?.toISOString() ?? null,
      };
    });
  }

  async updateProactive(
    principal: StaffPrincipal,
    brandId: string,
    proactive: ProactiveSettings,
  ): Promise<ProactiveSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.proactive', true);
      const before = (await brandSurface(tx, brand.id)).proactive;
      await this.save(tx, brand, { proactive });
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'brand.proactive.updated',
        targetType: 'brand',
        targetId: brandId,
        outcome: 'success',
        data: {
          enabled: { from: before.enabled, to: proactive.enabled },
          triggers: proactive.triggers.map((t) => ({ id: t.id, kind: t.kind, path: t.path })),
          maxPerDay: proactive.maxPerDay,
          dismissHours: proactive.dismissHours,
        },
      });
      return { brandId, settings: proactive, updatedAt: this.clock().toISOString() };
    });
  }
}
