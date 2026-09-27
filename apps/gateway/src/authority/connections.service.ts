import { ChatwootError, ChatwootUserAdoptedError, provisionAccount } from '@hamnivo/chatwoot';
import type { AuthorityConnection } from '@hamnivo/contracts';
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
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { AgentsService } from '../runtime/agents.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

type ConnectionRow = typeof schema.authorityConnections.$inferSelect;
type InboxRow = typeof schema.authorityInboxes.$inferSelect;

function connectionView(connection: ConnectionRow, inboxes: InboxRow[]): AuthorityConnection {
  return {
    id: toPublicId('connection', connection.id),
    kind: 'chatwoot',
    baseUrl: connection.baseUrl,
    accountId: connection.accountId,
    status: connection.status,
    inboxes: inboxes
      .filter((i) => i.connectionId === connection.id)
      .map((i) => ({
        id: toPublicId('inbox', i.id),
        brandId: i.brandId ? toPublicId('brand', i.brandId) : null,
        purpose: i.purpose,
        externalInboxId: i.externalInboxId,
      })),
    createdAt: connection.createdAt.toISOString(),
  };
}

/**
 * Connects a brand to Chatwoot (ADR 0001): provisions the account through the operator's Platform
 * App and stores every credential with the secret broker. One Chatwoot account per brand.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly agents: AgentsService,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private decide(principal: StaffPrincipal, resource: object) {
    enforce(
      authorize(principal, 'integrations.manage', resource, {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
      }),
    );
  }

  async list(principal: StaffPrincipal): Promise<AuthorityConnection[]> {
    this.decide(principal, {});
    return this.tx(principal, async (tx) => {
      const connections = await tx
        .select()
        .from(schema.authorityConnections)
        .orderBy(asc(schema.authorityConnections.createdAt));
      const inboxes = connections.length
        ? await tx
            .select()
            .from(schema.authorityInboxes)
            .where(
              inArray(
                schema.authorityInboxes.connectionId,
                connections.map((c) => c.id),
              ),
            )
        : [];
      return connections.map((c) => connectionView(c, inboxes));
    });
  }

  async connectChatwoot(
    principal: StaffPrincipal,
    brandPublicId: string,
  ): Promise<AuthorityConnection> {
    const brandId = fromPublicId('brand', brandPublicId);
    const baseUrl = this.config.CHATWOOT_URL?.replace(/\/$/, '');
    const platformToken = this.config.CHATWOOT_PLATFORM_TOKEN;
    const context = await this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      this.decide(principal, { workspaceId: brand.workspaceId, brandId });
      const [tenant] = await tx
        .select({ name: schema.tenants.name })
        .from(schema.tenants)
        .where(eq(schema.tenants.id, principal.tenantId));
      const [existing] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, brandId),
            eq(schema.authorityInboxes.purpose, 'live'),
          ),
        );
      return { brand, tenantName: tenant?.name ?? 'Hamnivo', existing };
    });
    if (context.existing) {
      return this.view(principal, context.existing.connectionId);
    }
    if (!baseUrl || !platformToken) {
      throw new AppError('FEATURE_DISABLED', {
        detail:
          'Chatwoot is not configured on this server (set CHATWOOT_URL and CHATWOOT_PLATFORM_TOKEN).',
      });
    }

    const connectionId = newId();
    const hookBase = `${(this.config.CHATWOOT_WEBHOOK_BASE_URL ?? this.config.PUBLIC_API_ORIGIN).replace(/\/$/, '')}/v1/integrations/chatwoot/${toPublicId('connection', connectionId)}`;
    let provisioned: Awaited<ReturnType<typeof provisionAccount>>;
    try {
      provisioned = await provisionAccount({
        baseUrl,
        platformToken,
        accountName: `${context.tenantName} · ${context.brand.name}`,
        integrationEmail: `hv-integration-${connectionId}@integration.hamnivo.invalid`,
        webhookUrls: {
          account: `${hookBase}/account`,
          inbox: `${hookBase}/inbox`,
          bot: `${hookBase}/bot`,
        },
        inboxName: context.brand.name,
        botName: `${context.brand.name} AI`,
        copilotUrl: `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/embed/copilot`,
      });
    } catch (error) {
      this.logger.warn(`Chatwoot provisioning failed: ${String(error)}`);
      if (error instanceof ChatwootUserAdoptedError) {
        throw new AppError('VERSION_CONFLICT', {
          detail:
            'Chatwoot already has a user with the integration address; an administrator must review it.',
          internal: error,
        });
      }
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot could not be provisioned. Nothing was saved; try again.',
        retryable: error instanceof ChatwootError ? error.retryable : true,
        internal: error,
      });
    }

    const tenantId = principal.tenantId;
    return this.tx(principal, async (tx) => {
      const store = (kind: string, label: string, value: string) =>
        this.secrets.storeIn(tx, tenantId, { kind, label, value });
      const brandName = context.brand.name;
      const integrationSecret = await store(
        'chatwoot_user_token',
        `Chatwoot integration user · ${brandName}`,
        provisioned.integration.token,
      );
      const accountHookSecret = await store(
        'webhook_signing',
        `Chatwoot account webhook · ${brandName}`,
        provisioned.accountWebhook.secret,
      );
      const hmacSecret = await store(
        'chatwoot_inbox_hmac',
        `Chatwoot inbox identity key · ${brandName}`,
        provisioned.inbox.hmacToken,
      );
      const inboxHookSecret = await store(
        'webhook_signing',
        `Chatwoot inbox webhook · ${brandName}`,
        provisioned.inbox.webhookSecret,
      );
      const botSecret = await store(
        'chatwoot_bot_token',
        `Chatwoot AI bot · ${brandName}`,
        provisioned.bot.token,
      );
      const botHookSecret = await store(
        'webhook_signing',
        `Chatwoot bot webhook · ${brandName}`,
        provisioned.bot.webhookSecret,
      );
      const [connection] = await tx
        .insert(schema.authorityConnections)
        .values({
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
          webhookSecretId: accountHookSecret,
          integrationTokenSecretId: integrationSecret,
          botTokenSecretId: botSecret,
        })
        .returning();
      const [inbox] = await tx
        .insert(schema.authorityInboxes)
        .values({
          tenantId,
          connectionId,
          brandId,
          purpose: 'live',
          externalInboxId: provisioned.inbox.id,
          inboxIdentifier: provisioned.inbox.identifier,
          hmacSecretId: hmacSecret,
          webhookSecretId: inboxHookSecret,
          channelType: 'Channel::Api',
        })
        .returning();
      await tx.insert(schema.authorityBots).values({
        tenantId,
        connectionId,
        externalBotId: provisioned.bot.id,
        name: `${brandName} AI`,
        role: 'primary',
        accessTokenSecretId: botSecret,
        webhookSecretId: botHookSecret,
      });
      if (!connection || !inbox) throw new Error('connection insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'authority.connected',
        targetType: 'authority_connection',
        targetId: toPublicId('connection', connectionId),
        outcome: 'success',
        data: {
          kind: 'chatwoot',
          baseUrl,
          accountId: provisioned.accountId,
          brandId: toPublicId('brand', brandId),
        },
      });
      // A ready-made agent draft; nothing AI-written reaches customers until it is published.
      await this.agents.ensureDefaultDraft(tx, context.brand);
      await enqueueOutbox(tx, tenantId, {
        topic: 'authority.connected',
        aggregateType: 'authority_connection',
        aggregateId: connectionId,
        payload: { accountId: provisioned.accountId, brandId },
      });
      return connectionView(connection, [inbox]);
    });
  }

  private async view(
    principal: StaffPrincipal,
    connectionId: string,
  ): Promise<AuthorityConnection> {
    return this.tx(principal, async (tx) => {
      const [connection] = await tx
        .select()
        .from(schema.authorityConnections)
        .where(eq(schema.authorityConnections.id, connectionId));
      if (!connection) throw new AppError('NOT_FOUND');
      const inboxes = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.connectionId, connectionId));
      return connectionView(connection, inboxes);
    });
  }
}
