import type { WidgetAppearance, WidgetAppearanceView } from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { colourIssues, colourProblem, parseAppearance } from './appearance.js';

/**
 * How a brand's chat looks and what it says (W03): the main colour (readable on a white panel, by
 * the repo's own contrast check), logo, corners, greeting, offline text, rating and privacy link.
 * Needs widget.configure. A change is audited and publishes a new configuration version, which
 * the chat and its loader pick up at once, like the rest of the chat's settings.
 */
@Injectable()
export class WidgetAppearanceService {
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

  /** The brand, locked when it changes, once the caller may configure its chat. */
  private async brand(
    tx: TenantTx,
    principal: StaffPrincipal,
    brandPublicId: string,
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
        'widget.configure',
        { workspaceId: brand.workspaceId, brandId },
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
      ),
    );
    return brand;
  }

  async get(principal: StaffPrincipal, brandPublicId: string): Promise<WidgetAppearanceView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, false);
      const [row] = await tx
        .select()
        .from(schema.brandAppearance)
        .where(eq(schema.brandAppearance.brandId, brand.id));
      return {
        brandId: brandPublicId,
        appearance: parseAppearance(row?.appearance),
        draftAppearance: row?.draftAppearance ? parseAppearance(row.draftAppearance) : null,
        draftRevision: row?.draftRevision ?? 0,
        configVersion: brand.configVersion,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  async set(
    principal: StaffPrincipal,
    brandPublicId: string,
    input: WidgetAppearance,
  ): Promise<WidgetAppearanceView> {
    return this.write(principal, brandPublicId, { mode: 'legacy', appearance: input });
  }

  async saveDraft(
    principal: StaffPrincipal,
    brandPublicId: string,
    appearance: WidgetAppearance,
    expectedRevision: number,
  ): Promise<WidgetAppearanceView> {
    return this.write(principal, brandPublicId, { mode: 'draft', appearance, expectedRevision });
  }

  async publish(
    principal: StaffPrincipal,
    brandPublicId: string,
    expectedRevision: number,
  ): Promise<WidgetAppearanceView> {
    return this.write(principal, brandPublicId, { mode: 'publish', expectedRevision });
  }

  private async write(
    principal: StaffPrincipal,
    brandPublicId: string,
    change:
      | { mode: 'legacy'; appearance: WidgetAppearance }
      | { mode: 'draft'; appearance: WidgetAppearance; expectedRevision: number }
      | { mode: 'publish'; expectedRevision: number },
  ): Promise<WidgetAppearanceView> {
    return this.tx(principal, async (tx) => {
      const brand = await this.brand(tx, principal, brandPublicId, true);
      const [existing] = await tx
        .select()
        .from(schema.brandAppearance)
        .where(eq(schema.brandAppearance.brandId, brand.id));
      const revision = existing?.draftRevision ?? 0;
      if (change.mode !== 'legacy' && change.expectedRevision !== revision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'The appearance changed. Reload before saving or publishing.',
        });
      }
      if (change.mode === 'publish' && !existing?.draftAppearance) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Save an appearance draft before publishing.',
        });
      }
      const input =
        change.mode === 'publish' ? parseAppearance(existing?.draftAppearance) : change.appearance;
      const issue = colourIssues(input.primaryColor)[0];
      if (issue)
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'primaryColor', message: colourProblem(issue) }],
        });
      const next: WidgetAppearance = { ...input, primaryColor: input.primaryColor.toUpperCase() };
      const before = parseAppearance(existing?.appearance);
      const appearance = change.mode === 'draft' ? before : next;
      const draftAppearance = change.mode === 'draft' ? next : null;
      const draftRevision = revision + 1;
      const now = this.clock();
      const values = {
        appearance,
        draftAppearance,
        draftRevision,
        updatedBy: principal.staffMemberId,
        updatedAt: now,
      };
      await tx
        .insert(schema.brandAppearance)
        .values({ tenantId: brand.tenantId, brandId: brand.id, ...values })
        .onConflictDoUpdate({
          target: [schema.brandAppearance.tenantId, schema.brandAppearance.brandId],
          set: values,
        });
      const configVersion = change.mode === 'draft' ? brand.configVersion : brand.configVersion + 1;
      if (change.mode !== 'draft') {
        await tx
          .update(schema.brands)
          .set({ configVersion, updatedAt: now })
          .where(eq(schema.brands.id, brand.id));
      }
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action:
          change.mode === 'draft' ? 'brand.appearance.draft_saved' : 'brand.appearance.updated',
        targetType: 'brand',
        targetId: brandPublicId,
        outcome: 'success',
        data: { before, after: next, draftRevision, published: change.mode !== 'draft' },
      });
      return {
        brandId: brandPublicId,
        appearance,
        draftAppearance,
        draftRevision,
        configVersion,
        updatedAt: now.toISOString(),
      };
    });
  }
}
