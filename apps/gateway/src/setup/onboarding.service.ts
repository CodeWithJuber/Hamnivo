import {
  ONBOARDING_STEPS,
  type OnboardingProgress,
  type OnboardingStep,
  OnboardingUseCase,
  type UpdateOnboardingRequest,
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
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type Row = typeof schema.onboardingProgress.$inferSelect;
type Steps = OnboardingProgress['steps'];

/** The steps a row holds that the wizard still knows, each as `done` or `skipped`. */
function stepsOf(row: Row | undefined): Steps {
  const steps: Steps = {};
  for (const step of ONBOARDING_STEPS) {
    const state = row?.steps[step];
    if (state === 'done' || state === 'skipped') steps[step] = state;
  }
  return steps;
}

function view(row: Row | undefined): OnboardingProgress {
  return {
    steps: stepsOf(row),
    useCase: OnboardingUseCase.safeParse(row?.steps.useCase).data ?? null,
    brandId: row?.brandId ? toPublicId('brand', row.brandId) : null,
    finishedAt: row?.finishedAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

/**
 * Where the owner is in the setup wizard (A01), so setup can be left and picked up again, from
 * another device too. It keeps only what the data cannot say: which steps were done or skipped,
 * the brand being set up and when the wizard was finished. Whether a brand exists or a key works
 * is read from there. Needs brands.manage across the workspace.
 */
@Injectable()
export class OnboardingService {
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

  private enforceManage(principal: StaffPrincipal) {
    enforce(
      authorize(
        principal,
        'brands.manage',
        {},
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 },
      ),
    );
  }

  async get(principal: StaffPrincipal): Promise<OnboardingProgress> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
      const [row] = await tx.select().from(schema.onboardingProgress);
      return view(row);
    });
  }

  async update(
    principal: StaffPrincipal,
    input: z.output<typeof UpdateOnboardingRequest>,
  ): Promise<OnboardingProgress> {
    this.enforceManage(principal);
    return this.tx(principal, async (tx) => {
      let brandId: string | null | undefined;
      if (input.brandId !== undefined) {
        brandId = null;
        if (input.brandId !== null) {
          let id: string;
          try {
            id = fromPublicId('brand', input.brandId);
          } catch {
            throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
          }
          const [brand] = await tx
            .select({ id: schema.brands.id })
            .from(schema.brands)
            .where(eq(schema.brands.id, id));
          if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
          brandId = brand.id;
        }
      }
      const [existing] = await tx.select().from(schema.onboardingProgress).for('update');
      const steps: Record<string, string> = { ...stepsOf(existing) };
      const useCase = input.useCase === undefined ? existing?.steps.useCase : input.useCase;
      if (useCase && OnboardingUseCase.safeParse(useCase).success) steps.useCase = useCase;
      for (const [step, state] of Object.entries(input.steps ?? {}) as [
        OnboardingStep,
        'done' | 'skipped' | null,
      ][]) {
        if (state === null) delete steps[step];
        else steps[step] = state;
      }
      const now = this.clock();
      const finishedAt =
        input.finished === undefined
          ? (existing?.finishedAt ?? null)
          : input.finished
            ? (existing?.finishedAt ?? now)
            : null;
      const values = {
        steps,
        brandId: brandId === undefined ? (existing?.brandId ?? null) : brandId,
        finishedAt,
        updatedBy: principal.staffMemberId,
        updatedAt: now,
      };
      const [row] = await tx
        .insert(schema.onboardingProgress)
        .values({ tenantId: principal.tenantId, ...values })
        .onConflictDoUpdate({ target: schema.onboardingProgress.tenantId, set: values })
        .returning();
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'onboarding.updated',
        targetType: 'tenant',
        targetId: toPublicId('tenant', principal.tenantId),
        outcome: 'success',
        data: {
          steps: input.steps ?? {},
          finished: input.finished ?? null,
          useCase: input.useCase ?? null,
        },
      });
      return view(row);
    });
  }
}
