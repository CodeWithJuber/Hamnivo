import type { AuthorityConnection } from '@hamnivo/contracts';
import { type Db, fromPublicId, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ChatwootProvisioning } from './provisioning.service.js';

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
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly provisioning: ChatwootProvisioning,
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

  /**
   * Connects a brand to Chatwoot. The set-up itself is the one the worker runs by itself for a
   * workspace's first brand (ChatwootProvisioning), so Connect is also its retry: it continues
   * from the last step an earlier attempt recorded, never a second account.
   */
  async connectChatwoot(
    principal: StaffPrincipal,
    brandPublicId: string,
  ): Promise<AuthorityConnection> {
    const brandId = fromPublicId('brand', brandPublicId);
    const existing = await this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      this.decide(principal, { workspaceId: brand.workspaceId, brandId });
      const [live] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(
          and(
            eq(schema.authorityInboxes.brandId, brandId),
            eq(schema.authorityInboxes.purpose, 'live'),
          ),
        );
      return live ?? null;
    });
    if (existing) return this.view(principal, existing.connectionId);
    if (!this.provisioning.configured) {
      throw new AppError('FEATURE_DISABLED', {
        detail:
          'Chatwoot is not configured on this server (set CHATWOOT_URL and CHATWOOT_PLATFORM_TOKEN).',
      });
    }
    const connectionId = await this.provisioning.runForRequest(
      principal.tenantId,
      brandId,
      toPublicId('staff', principal.staffMemberId),
    );
    return this.view(principal, connectionId);
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
