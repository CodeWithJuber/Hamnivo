import { addInboxMembers, provisionStaffUser } from '@hamnivo/chatwoot';
import { type Db, schema, withTenant } from '@hamnivo/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CONFIG } from '../tokens.js';
import type { ConnectionRuntime } from './registry.js';

/**
 * Staff ↔ Chatwoot users. Each staff member acts in Chatwoot as their own user (never a shared
 * account), created by Hamnivo through the Platform API with the agent role and inbox access.
 */
@Injectable()
export class StaffLinksService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async externalUserId(
    tenantId: string,
    connectionId: string,
    staffMemberId: string,
  ): Promise<number | null> {
    const [link] = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .select({ externalUserId: schema.staffAuthorityLinks.externalUserId })
        .from(schema.staffAuthorityLinks)
        .where(
          and(
            eq(schema.staffAuthorityLinks.connectionId, connectionId),
            eq(schema.staffAuthorityLinks.staffMemberId, staffMemberId),
            eq(schema.staffAuthorityLinks.status, 'active'),
          ),
        ),
    );
    return link?.externalUserId ?? null;
  }

  /** The staff member linked to a Chatwoot user, if any. */
  async staffOf(
    tenantId: string,
    connectionId: string,
    externalUserId: number,
  ): Promise<string | null> {
    const [link] = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .select({ staffMemberId: schema.staffAuthorityLinks.staffMemberId })
        .from(schema.staffAuthorityLinks)
        .where(
          and(
            eq(schema.staffAuthorityLinks.connectionId, connectionId),
            eq(schema.staffAuthorityLinks.externalUserId, externalUserId),
            eq(schema.staffAuthorityLinks.status, 'active'),
          ),
        ),
    );
    return link?.staffMemberId ?? null;
  }

  async ensure(runtime: ConnectionRuntime, staffMemberId: string): Promise<number> {
    const { tenantId, connectionId } = runtime;
    const existing = await this.externalUserId(tenantId, connectionId, staffMemberId);
    if (existing !== null) return existing;
    if (!this.config.CHATWOOT_PLATFORM_TOKEN) {
      throw new AppError('AUTHORITY_UNAVAILABLE', {
        detail: 'Chatwoot Platform App token is not configured.',
      });
    }
    const [staff] = await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .select({ displayName: schema.staffMembers.displayName })
        .from(schema.staffMembers)
        .where(eq(schema.staffMembers.id, staffMemberId)),
    );
    if (!staff) throw new AppError('NOT_FOUND', { detail: 'Staff member not found.' });
    const user = await provisionStaffUser({
      baseUrl: runtime.baseUrl,
      platformToken: this.config.CHATWOOT_PLATFORM_TOKEN,
      accountId: runtime.accountId,
      name: staff.displayName,
      email: `hv-staff-${staffMemberId}@staff.hamnivo.invalid`,
      role: 'agent',
      adoptOwnAddress: true,
    });
    // Web chat and channel inboxes: an agent sees and answers only the inboxes they belong to.
    for (const inbox of runtime.inboxes.filter((i) => i.purpose !== 'import')) {
      await addInboxMembers({
        baseUrl: runtime.baseUrl,
        token: runtime.integrationToken,
        accountId: runtime.accountId,
        inboxId: inbox.externalInboxId,
        userIds: [user.userId],
      });
    }
    await withTenant(this.db, { tenantId }, (tx) =>
      tx
        .insert(schema.staffAuthorityLinks)
        .values({
          tenantId,
          staffMemberId,
          connectionId,
          externalUserId: user.userId,
          authorityRole: 'agent',
        })
        .onConflictDoNothing(),
    );
    return (await this.externalUserId(tenantId, connectionId, staffMemberId)) ?? user.userId;
  }
}
