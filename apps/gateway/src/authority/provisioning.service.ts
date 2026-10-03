import { createHash } from 'node:crypto';
import {
  ChatwootError,
  ChatwootUserAdoptedError,
  type ProvisionedAccount,
  type ProvisionProgress,
  type ProvisionStep,
  provisionAccountResumable,
} from '@hamnivo/chatwoot';
import type { ProvisioningStatus } from '@hamnivo/contracts';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

/** Outbox topic of an automatic Chatwoot set-up (the first brand of a workspace). */
export const PROVISION_TOPIC = 'chatwoot.provision';

/** How long one attempt may hold a brand's set-up (every Chatwoot call has its own timeout). */
const LEASE_MS = 5 * 60_000;
/**
 * The automatic set-up of a new first brand waits a little: someone who clicks Connect right
 * away goes first, and either way the brand ends up with one account.
 */
const AUTO_DELAY_MS = 20_000;

type Trigger = 'tenant.created' | 'brand.created' | 'manual';

/** What exists in Chatwoot so far, as stored: ids and secret ids, never secrets. */
interface Recorded {
  accountId?: number;
  integration?: { userId: number; tokenSecretId: string };
  integrationMember?: boolean;
  inbox?: { id: number; identifier: string; hmacSecretId: string; webhookSecretId: string };
  bot?: { id: number; tokenSecretId: string; webhookSecretId: string };
  botAttached?: boolean;
  accountWebhook?: { id: number; secretId: string };
  dashboardAppId?: number | null;
}

type ProvisioningRow = typeof schema.chatwootProvisioning.$inferSelect;

/** The connection id of a brand's Chatwoot account, fixed before the first attempt. */
export function connectionIdFor(tenantId: string, brandId: string): string {
  const bytes = createHash('sha256')
    .update(`chatwoot:${tenantId}:${brandId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function recordQueued(tx: TenantTx, tenantId: string, brandId: string, trigger: Trigger) {
  await tx
    .insert(schema.chatwootProvisioning)
    .values({
      tenantId,
      brandId,
      connectionId: connectionIdFor(tenantId, brandId),
      state: 'queued',
      trigger,
    })
    .onConflictDoNothing({
      target: [schema.chatwootProvisioning.tenantId, schema.chatwootProvisioning.brandId],
    });
}

/**
 * Queues the automatic Chatwoot set-up when this brand is the workspace's first (call it in the
 * transaction that created the brand). Nothing happens when Chatwoot is not configured or the
 * server turned the automatic set-up off (CHATWOOT_AUTO_PROVISION=false).
 */
export async function queueFirstBrandSetup(
  tx: TenantTx,
  config: AppConfig,
  tenantId: string,
  brandId: string,
  now: Date,
): Promise<void> {
  if (!config.CHATWOOT_AUTO_PROVISION || !config.CHATWOOT_URL || !config.CHATWOOT_PLATFORM_TOKEN) {
    return;
  }
  const [brands] = await tx.select({ n: count() }).from(schema.brands);
  if ((brands?.n ?? 0) !== 1) return;
  await recordQueued(tx, tenantId, brandId, 'brand.created');
  await enqueueOutbox(tx, tenantId, {
    topic: PROVISION_TOPIC,
    aggregateType: 'brand',
    aggregateId: brandId,
    payload: { brandId, trigger: 'brand.created' },
    availableAt: new Date(now.getTime() + AUTO_DELAY_MS),
  });
}

/** Records a queued set-up for a brand created with its workspace (the tenant.created handler runs it). */
export const queueTenantBrandSetup = (tx: TenantTx, tenantId: string, brandId: string) =>
  recordQueued(tx, tenantId, brandId, 'tenant.created');

/** Another attempt holds the set-up; the outbox tries again later. */
class SetupBusyError extends Error {
  override name = 'SetupBusyError';
}

function safeMessage(error: unknown): string {
  if (error instanceof ChatwootUserAdoptedError) {
    return 'Chatwoot already has a user with the integration address; an administrator must review it.';
  }
  if (error instanceof ChatwootError) {
    return `Chatwoot ${error.operation} failed (HTTP ${error.status || 'no answer'}).`;
  }
  return 'The set-up stopped unexpectedly.';
}

const retryable = (error: unknown) =>
  !(error instanceof ChatwootUserAdoptedError) &&
  (!(error instanceof ChatwootError) || error.retryable);

/**
 * Sets up a brand's Chatwoot account (ADR 0001: one account per brand) by itself: the
 * tenant.created handler does it for a brand created with the workspace, and the first brand a
 * workspace adds queues it through the outbox. Manual Connect in Studio runs the same steps, so
 * it is the retry. Each completed step is recorded before the next one starts (secrets go to the
 * secret broker), a lease keeps two attempts apart, and the connection id is fixed up front, so a
 * retry continues the same account instead of creating another one.
 */
@Injectable()
export class ChatwootProvisioning {
  private readonly logger = new Logger(ChatwootProvisioning.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly agents: AgentsService,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.CHATWOOT_URL && this.config.CHATWOOT_PLATFORM_TOKEN);
  }

  /** tenant.created: a brand created with the workspace (operator API) is set up now. */
  async onTenantCreated(event: ClaimedOutboxEvent): Promise<void> {
    this.logger.log(`tenant created: ${event.aggregateId}`);
    const brandId = (event.payload as { brandId?: unknown }).brandId;
    if (typeof brandId !== 'string' || !this.config.CHATWOOT_AUTO_PROVISION || !this.configured) {
      return;
    }
    await this.runForWorker(event.tenantId, brandId, 'tenant.created');
  }

  /** chatwoot.provision: the first brand of a workspace. */
  async onProvision(event: ClaimedOutboxEvent): Promise<void> {
    const brandId = (event.payload as { brandId?: unknown }).brandId;
    if (typeof brandId !== 'string' || !this.config.CHATWOOT_AUTO_PROVISION || !this.configured) {
      return;
    }
    await this.runForWorker(event.tenantId, brandId, 'brand.created');
  }

  private async runForWorker(tenantId: string, brandId: string, trigger: Trigger) {
    try {
      await this.run(tenantId, brandId, trigger, null);
    } catch (error) {
      // Throwing hands the event back to the outbox, which retries with backoff. A failure no
      // retry can fix is recorded and left for a person (Connect in Studio retries it).
      if (error instanceof SetupBusyError || retryable(error)) throw error;
    }
  }

  /** Manual Connect: the same set-up, now, for a person in Studio. Returns the connection id. */
  async runForRequest(tenantId: string, brandId: string, staffActorId: string): Promise<string> {
    try {
      return await this.run(tenantId, brandId, 'manual', staffActorId);
    } catch (error) {
      if (error instanceof SetupBusyError) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Chat for this brand is being set up right now. Check again in a minute.',
        });
      }
      if (error instanceof AppError) throw error;
      this.logger.warn(`Chatwoot provisioning failed: ${String(error)}`);
      if (error instanceof ChatwootUserAdoptedError) {
        throw new AppError('VERSION_CONFLICT', { detail: safeMessage(error), internal: error });
      }
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be set up. What was done is kept; try again to continue.',
        retryable: retryable(error),
        internal: error,
      });
    }
  }

  /** The set-up of each brand, for Studio's progress. */
  async list(tenantId: string): Promise<z.infer<typeof ProvisioningStatus>[]> {
    const rows = await withTenant(this.db, { tenantId }, (tx) =>
      tx.select().from(schema.chatwootProvisioning),
    );
    return rows.map((row) => ({
      brandId: toPublicId('brand', row.brandId),
      state: row.state,
      step: row.step,
      attempts: row.attempts,
      lastError: row.lastError,
      updatedAt: row.updatedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(this.db, { tenantId, actorId: 'provisioning' }, work);
  }

  private async run(
    tenantId: string,
    brandId: string,
    trigger: Trigger,
    staffActorId: string | null,
  ): Promise<string> {
    if (!this.configured) {
      throw new AppError('FEATURE_DISABLED', {
        detail:
          'Chatwoot is not configured on this server (set CHATWOOT_URL and CHATWOOT_PLATFORM_TOKEN).',
      });
    }
    const claim = await this.tx(tenantId, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) return { skip: 'no_brand' as const };
      const [live] = await tx
        .select({ connectionId: schema.authorityInboxes.connectionId })
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, brandId),
            eq(schema.authorityInboxes.purpose, 'live'),
          ),
        );
      if (live) {
        await recordQueued(tx, tenantId, brandId, trigger);
        await tx
          .update(schema.chatwootProvisioning)
          .set({ state: 'connected', step: 'done', lockedUntil: null, lastError: null })
          .where(eq(schema.chatwootProvisioning.brandId, brandId));
        return { skip: 'connected' as const, connectionId: live.connectionId };
      }
      await recordQueued(tx, tenantId, brandId, trigger);
      const now = this.clock();
      const t = schema.chatwootProvisioning;
      const [row] = await tx
        .update(t)
        .set({
          state: 'running',
          attempts: sql`${t.attempts} + 1`,
          lockedUntil: new Date(now.getTime() + LEASE_MS),
          startedAt: sql`coalesce(${t.startedAt}, ${now.toISOString()}::timestamptz)`,
          lastError: null,
        })
        .where(
          and(
            eq(t.brandId, brandId),
            sql`(${t.lockedUntil} is null or ${t.lockedUntil} < ${now.toISOString()}::timestamptz)`,
            sql`${t.state} <> 'connected'`,
          ),
        )
        .returning();
      if (!row) return { skip: 'busy' as const };
      const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
      return { row, brand, tenantName: tenant?.name ?? 'Hamnivo' };
    });
    if ('skip' in claim) {
      if (claim.skip === 'connected') return claim.connectionId;
      if (claim.skip === 'busy') throw new SetupBusyError('another attempt holds the set-up');
      throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
    }
    const { row, brand, tenantName } = claim;
    try {
      const recorded = { ...(row.progress as Recorded) };
      const progress = await this.tx(tenantId, (tx) => this.reveal(tx, tenantId, recorded));
      const baseUrl = (this.config.CHATWOOT_URL as string).replace(/\/$/, '');
      const hookBase = `${(this.config.CHATWOOT_WEBHOOK_BASE_URL ?? this.config.PUBLIC_API_ORIGIN).replace(/\/$/, '')}/v1/integrations/chatwoot/${toPublicId('connection', row.connectionId)}`;
      const provisioned = await provisionAccountResumable({
        baseUrl,
        platformToken: this.config.CHATWOOT_PLATFORM_TOKEN as string,
        accountName: `${tenantName} · ${brand.name}`,
        integrationEmail: `hv-integration-${row.connectionId}@integration.hamnivo.invalid`,
        webhookUrls: {
          account: `${hookBase}/account`,
          inbox: `${hookBase}/inbox`,
          bot: `${hookBase}/bot`,
        },
        inboxName: brand.name,
        botName: `${brand.name} AI`,
        copilotUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/embed/copilot`,
        adoptOwnAddress: true,
        progress,
        onProgress: (next, step) => this.record(tenantId, row, brand.name, recorded, next, step),
      });
      await this.finish(tenantId, row, brand, baseUrl, recorded, provisioned, staffActorId);
      return row.connectionId;
    } catch (error) {
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.chatwootProvisioning)
          .set({ state: 'failed', lastError: safeMessage(error), lockedUntil: null })
          .where(eq(schema.chatwootProvisioning.id, row.id)),
      ).catch((cause: unknown) =>
        this.logger.error(`could not record the failed set-up: ${String(cause)}`),
      );
      this.logger.warn(`Chatwoot set-up of brand ${brandId} failed: ${safeMessage(error)}`);
      throw error;
    }
  }

  /** The recorded steps with their secrets, to hand back to provisioning. */
  private async reveal(tx: TenantTx, tenantId: string, r: Recorded): Promise<ProvisionProgress> {
    const open = (secretId: string) => this.secrets.reveal(tx, tenantId, secretId);
    return {
      ...(r.accountId !== undefined ? { accountId: r.accountId } : {}),
      ...(r.integration
        ? {
            integration: {
              userId: r.integration.userId,
              token: await open(r.integration.tokenSecretId),
            },
          }
        : {}),
      ...(r.integrationMember ? { integrationMember: true } : {}),
      ...(r.inbox
        ? {
            inbox: {
              id: r.inbox.id,
              identifier: r.inbox.identifier,
              hmacToken: await open(r.inbox.hmacSecretId),
              webhookSecret: await open(r.inbox.webhookSecretId),
            },
          }
        : {}),
      ...(r.bot
        ? {
            bot: {
              id: r.bot.id,
              token: await open(r.bot.tokenSecretId),
              webhookSecret: await open(r.bot.webhookSecretId),
            },
          }
        : {}),
      ...(r.botAttached ? { botAttached: true } : {}),
      ...(r.accountWebhook
        ? {
            accountWebhook: {
              id: r.accountWebhook.id,
              secret: await open(r.accountWebhook.secretId),
            },
          }
        : {}),
      ...(r.dashboardAppId !== undefined ? { dashboardAppId: r.dashboardAppId } : {}),
    };
  }

  /** Stores what a step created (secrets through the broker) and extends the lease. */
  private async record(
    tenantId: string,
    row: ProvisioningRow,
    brandName: string,
    recorded: Recorded,
    progress: ProvisionProgress,
    step: ProvisionStep,
  ): Promise<void> {
    await this.tx(tenantId, async (tx) => {
      const store = (kind: string, label: string, value: string) =>
        this.secrets.storeIn(tx, tenantId, { kind, label, value });
      if (progress.accountId !== undefined) recorded.accountId = progress.accountId;
      if (progress.integration && !recorded.integration) {
        recorded.integration = {
          userId: progress.integration.userId,
          tokenSecretId: await store(
            'chatwoot_user_token',
            `Chatwoot integration user · ${brandName}`,
            progress.integration.token,
          ),
        };
      }
      if (progress.integrationMember) recorded.integrationMember = true;
      if (progress.inbox && !recorded.inbox) {
        recorded.inbox = {
          id: progress.inbox.id,
          identifier: progress.inbox.identifier,
          hmacSecretId: await store(
            'chatwoot_inbox_hmac',
            `Chatwoot inbox identity key · ${brandName}`,
            progress.inbox.hmacToken,
          ),
          webhookSecretId: await store(
            'webhook_signing',
            `Chatwoot inbox webhook · ${brandName}`,
            progress.inbox.webhookSecret,
          ),
        };
      }
      if (progress.bot && !recorded.bot) {
        recorded.bot = {
          id: progress.bot.id,
          tokenSecretId: await store(
            'chatwoot_bot_token',
            `Chatwoot AI bot · ${brandName}`,
            progress.bot.token,
          ),
          webhookSecretId: await store(
            'webhook_signing',
            `Chatwoot bot webhook · ${brandName}`,
            progress.bot.webhookSecret,
          ),
        };
      }
      if (progress.botAttached) recorded.botAttached = true;
      if (progress.accountWebhook && !recorded.accountWebhook) {
        recorded.accountWebhook = {
          id: progress.accountWebhook.id,
          secretId: await store(
            'webhook_signing',
            `Chatwoot account webhook · ${brandName}`,
            progress.accountWebhook.secret,
          ),
        };
      }
      if (progress.dashboardAppId !== undefined) recorded.dashboardAppId = progress.dashboardAppId;
      await tx
        .update(schema.chatwootProvisioning)
        .set({
          progress: { ...recorded },
          step,
          lockedUntil: new Date(this.clock().getTime() + LEASE_MS),
        })
        .where(eq(schema.chatwootProvisioning.id, row.id));
    });
  }

  /** Creates the connection, inbox and bot records from the recorded steps, in one transaction. */
  private async finish(
    tenantId: string,
    row: ProvisioningRow,
    brand: typeof schema.brands.$inferSelect,
    baseUrl: string,
    recorded: Recorded,
    provisioned: ProvisionedAccount,
    staffActorId: string | null,
  ): Promise<void> {
    const { integration, inbox, bot, accountWebhook } = recorded;
    if (!integration || !inbox || !bot || !accountWebhook) {
      throw new Error('provisioning finished without every step recorded');
    }
    const connectionId = row.connectionId;
    await withTenant(this.db, { tenantId, actorId: staffActorId ?? 'provisioning' }, async (tx) => {
      await tx.insert(schema.authorityConnections).values({
        id: connectionId,
        tenantId,
        kind: 'chatwoot',
        baseUrl,
        accountId: provisioned.accountId,
        status: 'active',
        authorityVersion: '4.18.0',
        capabilities: {
          messageKeys: true,
          ownerCas: false,
          multiContact: false,
          customerEdits: false,
        },
        webhookSecretId: accountWebhook.secretId,
        integrationTokenSecretId: integration.tokenSecretId,
        botTokenSecretId: bot.tokenSecretId,
      });
      await tx.insert(schema.authorityInboxes).values({
        tenantId,
        connectionId,
        brandId: brand.id,
        purpose: 'live',
        externalInboxId: inbox.id,
        inboxIdentifier: inbox.identifier,
        hmacSecretId: inbox.hmacSecretId,
        webhookSecretId: inbox.webhookSecretId,
        channelType: 'Channel::Api',
      });
      await tx.insert(schema.authorityBots).values({
        tenantId,
        connectionId,
        externalBotId: bot.id,
        name: `${brand.name} AI`,
        role: 'primary',
        accessTokenSecretId: bot.tokenSecretId,
        webhookSecretId: bot.webhookSecretId,
      });
      await appendAudit(tx, {
        actorType: staffActorId ? 'staff' : 'system',
        actorId: staffActorId ?? 'provisioning',
        action: 'authority.connected',
        targetType: 'authority_connection',
        targetId: toPublicId('connection', connectionId),
        outcome: 'success',
        data: {
          kind: 'chatwoot',
          baseUrl,
          accountId: provisioned.accountId,
          brandId: toPublicId('brand', brand.id),
          trigger: row.trigger,
          attempts: row.attempts,
        },
      });
      // A ready-made agent draft; nothing AI-written reaches customers until it is published.
      await this.agents.ensureDefaultDraft(tx, brand);
      await enqueueOutbox(tx, tenantId, {
        topic: 'authority.connected',
        aggregateType: 'authority_connection',
        aggregateId: connectionId,
        payload: { accountId: provisioned.accountId, brandId: brand.id },
      });
      await tx
        .update(schema.chatwootProvisioning)
        .set({
          state: 'connected',
          step: 'done',
          lockedUntil: null,
          lastError: null,
          finishedAt: this.clock(),
        })
        .where(eq(schema.chatwootProvisioning.id, row.id));
    });
  }
}
