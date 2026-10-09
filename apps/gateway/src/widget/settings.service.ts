import {
  ConsentSettings,
  type ConsentSettingsView,
  type DirectLinkView,
  PromptLimits,
  type WidgetAppearance,
  WidgetForms,
  type WidgetFormsView,
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
import { type PublishedAutomation, publishedAutomations } from '../automations/definitions.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { teamsForBrand } from '../decisions/team-routing.service.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { parseAppearance } from './appearance.js';

export interface BrandSurface {
  settings: WidgetSettings;
  /** How many website prompts one visitor sees a day, and the quiet time after closing one. */
  promptLimits: PromptLimits;
  /** Website automations that are on and published (G21), in the brand's order. */
  prompts: PublishedAutomation[];
  /** How the chat looks and what it says (W03); the defaults when left out. */
  appearance?: WidgetAppearance;
  /** The pre-chat form (W26) and the contact form (W11). */
  forms: WidgetForms;
  /** Who must agree before chatting (W27), and the version of the words they agree to. */
  consent: ConsentSettings;
  consentVersion: number;
  /** The direct chat link is on (W28). */
  directLink: boolean;
  settingsUpdatedAt: Date | null;
  promptLimitsUpdatedAt: Date | null;
  formsUpdatedAt: Date | null;
  consentUpdatedAt: Date | null;
  directLinkUpdatedAt: Date | null;
}

/** Stored settings, or the contract's defaults when there are none or they no longer parse. */
function parsed<T>(schemaOf: z.ZodType<T>, value: unknown): T {
  const result = schemaOf.safeParse(value ?? {});
  return result.success ? result.data : schemaOf.parse({});
}

/** A brand's widget settings, website prompts and appearance (defaults when it has none). */
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
    promptLimits: parsed(PromptLimits, row?.proactive),
    prompts: await publishedAutomations(tx, brandId, 'visitor'),
    appearance: parseAppearance(look?.appearance),
    forms: parsed(WidgetForms, row?.forms),
    consent: parsed(ConsentSettings, row?.consent),
    consentVersion: row?.consentVersion ?? 0,
    directLink: row?.directLink ?? false,
    settingsUpdatedAt: row?.settingsUpdatedAt ?? null,
    promptLimitsUpdatedAt: row?.proactiveUpdatedAt ?? null,
    formsUpdatedAt: row?.formsUpdatedAt ?? null,
    consentUpdatedAt: row?.consentUpdatedAt ?? null,
    directLinkUpdatedAt: row?.directLinkUpdatedAt ?? null,
  };
}

/** The page that opens a brand's chat on its own (W28). */
export function directLinkUrl(widgetOrigin: string, widgetPublicId: string): string | null {
  try {
    return new URL(`/c/${encodeURIComponent(widgetPublicId)}`, widgetOrigin).toString();
  } catch {
    return null;
  }
}

export type SurfaceChange =
  | { settings: WidgetSettings }
  | { promptLimits: PromptLimits }
  | { forms: WidgetForms }
  | { consent: ConsentSettings; consentVersion: number }
  | { directLink: boolean };

function columnsOf(change: SurfaceChange, now: Date) {
  if ('settings' in change) return { settings: change.settings, settingsUpdatedAt: now };
  if ('promptLimits' in change) {
    return { proactive: change.promptLimits, proactiveUpdatedAt: now };
  }
  if ('forms' in change) return { forms: change.forms, formsUpdatedAt: now };
  if ('consent' in change) {
    return {
      consent: change.consent,
      consentVersion: change.consentVersion,
      consentUpdatedAt: now,
    };
  }
  return { directLink: change.directLink, directLinkUpdatedAt: now };
}

/** The same words in every language, whatever order the keys came in. */
function sameText(a: ConsentSettings['text'], b: ConsentSettings['text']): boolean {
  if (a === null || b === null) return a === b;
  return (['en', 'ar', 'hi', 'ur'] as const).every((l) => (a[l] ?? null) === (b[l] ?? null));
}

/**
 * Writes one column of a brand's settings row and publishes a new configuration version, which
 * the widget and the loader pick up at once. The brand row must be locked.
 */
export async function saveSurface(
  tx: TenantTx,
  brand: typeof schema.brands.$inferSelect,
  change: SurfaceChange,
  now: Date,
): Promise<number> {
  const values = columnsOf(change, now);
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

/**
 * Brand settings for the customer surface (Studio and the admin API): the widget's layout,
 * files, help home, deletion window, email offers, forms, consent and direct link need
 * widget.configure (website prompts are automations, G21). Each change is audited and publishes a
 * new configuration version, which the widget and the loader pick up at once.
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

  private save(
    tx: TenantTx,
    brand: typeof schema.brands.$inferSelect,
    change: SurfaceChange,
  ): Promise<number> {
    return saveSurface(tx, brand, change, this.clock());
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

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandId: string,
    action: string,
    data: Record<string, unknown>,
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'brand',
      targetId: brandId,
      outcome: 'success',
      data,
    });
  }

  async getForms(principal: StaffPrincipal, brandId: string): Promise<WidgetFormsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', false);
      const surface = await brandSurface(tx, brand.id);
      return {
        brandId,
        forms: surface.forms,
        configVersion: brand.configVersion,
        updatedAt: surface.formsUpdatedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Replaces both forms (W26, W11). A department answer must lead to a team that may take the
   * brand's conversations, so a customer's choice never routes a chat nowhere.
   */
  async updateForms(
    principal: StaffPrincipal,
    brandId: string,
    forms: WidgetForms,
  ): Promise<WidgetFormsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', true);
      const teams = new Set(
        (await teamsForBrand(tx, brand)).map((r) => toPublicId('team', r.team.id)),
      );
      for (const [formName, form] of [
        ['prechat', forms.prechat],
        ['offline', forms.offline],
      ] as const) {
        for (const [index, field] of form.fields.entries()) {
          if (field.kind !== 'department') continue;
          const unknown = field.options.findIndex((o) => !o.teamId || !teams.has(o.teamId));
          if (unknown >= 0) {
            throw new AppError('VALIDATION_FAILED', {
              detail: 'Each department leads to a support team that can take this brand’s chats.',
              fields: [
                {
                  path: `${formName}.fields.${index}.options.${unknown}.teamId`,
                  message: 'Choose one of the brand’s support teams',
                },
              ],
            });
          }
        }
      }
      const version = await this.save(tx, brand, { forms });
      await this.audit(tx, principal, brandId, 'brand.widget_forms.updated', {
        prechat: {
          enabled: forms.prechat.enabled,
          fields: forms.prechat.fields.map((f) => ({
            id: f.id,
            kind: f.kind,
            required: f.required,
          })),
        },
        offline: {
          enabled: forms.offline.enabled,
          when: forms.offline.when,
          fields: forms.offline.fields.map((f) => ({
            id: f.id,
            kind: f.kind,
            required: f.required,
          })),
        },
      });
      return {
        brandId,
        forms,
        configVersion: version,
        updatedAt: this.clock().toISOString(),
      };
    });
  }

  async getConsent(principal: StaffPrincipal, brandId: string): Promise<ConsentSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', false);
      const surface = await brandSurface(tx, brand.id);
      return {
        brandId,
        consent: surface.consent,
        noticeVersion: surface.consentVersion,
        configVersion: brand.configVersion,
        updatedAt: surface.consentUpdatedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Replaces the consent settings (W27). New words get a new version, so customers who agreed to
   * the old ones are asked again; turning consent on for the first time is version 1.
   */
  async updateConsent(
    principal: StaffPrincipal,
    brandId: string,
    consent: ConsentSettings,
  ): Promise<ConsentSettingsView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', true);
      const before = await brandSurface(tx, brand.id);
      const changed = !sameText(before.consent.text, consent.text) || before.consentVersion === 0;
      const noticeVersion = changed ? before.consentVersion + 1 : before.consentVersion;
      const version = await this.save(tx, brand, { consent, consentVersion: noticeVersion });
      await this.audit(tx, principal, brandId, 'brand.consent.updated', {
        mode: { from: before.consent.mode, to: consent.mode },
        noticeVersion: { from: before.consentVersion, to: noticeVersion },
      });
      return {
        brandId,
        consent,
        noticeVersion,
        configVersion: version,
        updatedAt: this.clock().toISOString(),
      };
    });
  }

  async getDirectLink(principal: StaffPrincipal, brandId: string): Promise<DirectLinkView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', false);
      const surface = await brandSurface(tx, brand.id);
      return {
        brandId,
        widgetId: brand.widgetPublicId,
        enabled: surface.directLink,
        url: directLinkUrl(this.config.PUBLIC_WIDGET_ORIGIN, brand.widgetPublicId),
        configVersion: brand.configVersion,
        updatedAt: surface.directLinkUpdatedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Turns the direct chat link on or off (W28). Off, a chat opened from the link ends at its next
   * token renewal, since the session's origin is checked again then.
   */
  async updateDirectLink(
    principal: StaffPrincipal,
    brandId: string,
    enabled: boolean,
  ): Promise<DirectLinkView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandId, 'widget.configure', true);
      const before = (await brandSurface(tx, brand.id)).directLink;
      const version = await this.save(tx, brand, { directLink: enabled });
      await this.audit(tx, principal, brandId, 'brand.direct_link.updated', {
        enabled: { from: before, to: enabled },
      });
      return {
        brandId,
        widgetId: brand.widgetPublicId,
        enabled,
        url: directLinkUrl(this.config.PUBLIC_WIDGET_ORIGIN, brand.widgetPublicId),
        configVersion: version,
        updatedAt: this.clock().toISOString(),
      };
    });
  }
}
