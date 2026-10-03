import type { PlatformSignup, SignupSettings } from '@hamnivo/contracts';
import { appendPlatformAudit, type Db, schema } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import type { AuthSession } from '../identity/auth.factory.js';
import type { OperatorContext } from '../identity/request-auth.js';
import { OperatorsService } from '../operations/operators.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG, PLATFORM_DB } from '../tokens.js';

const KEY = 'public_signup';

/**
 * Who may sign up (SaaS). HAMNIVO_PUBLIC_SIGNUP is the server's setting; a platform operator can
 * override it in the console (stored in platform_settings, read on every sign-up, so a change
 * applies at once). When sign-up is closed, people invited to a workspace may still create their
 * account, platform operators may still create workspaces for customers, and a new server always
 * accepts its first account and its first workspace, so nobody locks themselves out.
 */
@Injectable()
export class SignupPolicy {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(PLATFORM_DB) private readonly platform: Db | null,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly operators: OperatorsService,
  ) {}

  private async override(): Promise<{ open: boolean; updatedAt: Date } | null> {
    if (!this.platform) return null;
    const [row] = await this.platform
      .select()
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, KEY));
    const open = (row?.value as { open?: unknown } | undefined)?.open;
    return row && typeof open === 'boolean' ? { open, updatedAt: row.updatedAt } : null;
  }

  async isOpen(): Promise<boolean> {
    return (await this.override())?.open ?? this.config.HAMNIVO_PUBLIC_SIGNUP;
  }

  /** What the sign-up page needs (public). */
  async settings(): Promise<SignupSettings> {
    return {
      open: await this.isOpen(),
      turnstileSiteKey: this.config.TURNSTILE_SECRET_KEY
        ? (this.config.TURNSTILE_SITE_KEY ?? null)
        : null,
    };
  }

  async platformView(): Promise<z.infer<typeof PlatformSignup>> {
    const override = await this.override();
    return {
      open: override?.open ?? this.config.HAMNIVO_PUBLIC_SIGNUP,
      envDefault: this.config.HAMNIVO_PUBLIC_SIGNUP,
      overridden: override !== null,
      updatedAt: override?.updatedAt.toISOString() ?? null,
      turnstile: Boolean(this.config.TURNSTILE_SECRET_KEY),
      defaultPlan: this.config.HAMNIVO_DEFAULT_PLAN,
    };
  }

  /** Sets the console's override; null follows HAMNIVO_PUBLIC_SIGNUP again. Audited. */
  async set(
    operator: OperatorContext,
    open: boolean | null,
  ): Promise<z.infer<typeof PlatformSignup>> {
    if (!this.platform) throw new AppError('NOT_FOUND');
    const operatorId = operator.principal.operatorId;
    await this.platform.transaction(async (tx) => {
      // `open: null` is kept as a row too (settings are never deleted, so who changed it stays).
      await tx
        .insert(schema.platformSettings)
        .values({ key: KEY, value: { open }, updatedBy: operatorId })
        .onConflictDoUpdate({
          target: schema.platformSettings.key,
          set: { value: { open }, updatedBy: operatorId, updatedAt: this.clock() },
        });
      await appendPlatformAudit(tx, {
        operatorId,
        action: 'platform.signup_changed',
        targetType: 'setting',
        targetId: KEY,
        outcome: 'success',
        data: { open, envDefault: this.config.HAMNIVO_PUBLIC_SIGNUP },
      });
    });
    return this.platformView();
  }

  /** Better Auth asks before creating an account with a password. */
  async mayCreateAccount(email: string): Promise<boolean> {
    if (await this.isOpen()) return true;
    const { rows } = await this.db.execute<{ invited: boolean; anyone: boolean }>(
      sql`select app.invitation_pending_for(${email}) as invited,
                 exists (select 1 from auth."user") as anyone`,
    );
    return Boolean(rows[0]?.invited) || !rows[0]?.anyone;
  }

  /** Before a signed-in person creates a workspace (POST /v1/tenants). */
  async assertMayCreateTenant(session: AuthSession): Promise<void> {
    if (await this.isOpen()) return;
    if (await this.operators.operator(session)) return;
    const { rows } = await this.db.execute<{ exist: boolean }>(
      sql`select app.tenants_exist() as exist`,
    );
    if (!rows[0]?.exist) return;
    throw new AppError('FEATURE_DISABLED', {
      reason: 'signup_closed',
      detail:
        'New workspaces are not open to everyone on this server. Ask your provider for a workspace, or a teammate for an invitation.',
    });
  }
}
