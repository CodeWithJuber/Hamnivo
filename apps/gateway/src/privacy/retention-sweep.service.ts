import { ChatwootError, type ChatwootImporter } from '@hamnivo/chatwoot';
import {
  appendAudit,
  type Db,
  type RetentionDue,
  retentionDue,
  retentionOrphans,
  retentionTenants,
  retireConversation,
  retireCustomer,
  schema,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import type { AppConfig } from '../config.js';
import { MemoryDeletionService } from '../memory/deletion.service.js';
import { lockMemorySubject } from '../memory/locks.js';
import { importerFor } from '../migration/destination.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';

/** What happened to one conversation: gone, kept, or the chat engine stopped the sweep. */
type Outcome = 'deleted' | 'kept' | 'blocked' | 'unavailable';

/** History only the chat engine has, and customers left with nothing, are looked at hourly. */
const FULL_PASS_MS = 60 * 60 * 1000;
/** Pages of the chat engine's oldest resolved conversations read per inbox and pass. */
const HISTORY_PAGES = 4;

/**
 * The chat engine refused because its Hamnivo user may not delete (not an administrator): the
 * sweep stops for the workspace and says so. Anything else is a passing failure, tried next run.
 */
function outcomeOf(error: unknown): Outcome {
  return error instanceof ChatwootError && (error.status === 401 || error.status === 403)
    ? 'blocked'
    : 'unavailable';
}

interface TenantPass {
  tenantId: string;
  cutoff: Date;
  due: RetentionDue[];
  /** Whether to look at customers and the chat engine's own history this time. */
  full: boolean;
}

/**
 * Retention (A10): every ten minutes, deletes resolved conversations older than their workspace's
 * period, first in the chat engine and then in Hamnivo. Each step checks again that the
 * conversation is still resolved and old, so one reopened in the meantime stays. Hourly it also
 * deletes old conversations only the chat engine has (imported history, chats never adopted), and
 * removes customers left with no conversation, their memory first. Every step can run twice.
 */
@Injectable()
export class RetentionSweep {
  private readonly logger = new Logger(RetentionSweep.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
    private readonly memory: MemoryDeletionService,
  ) {}

  async run(): Promise<{ conversations: number; customers: number }> {
    const due = await retentionDue(
      this.db,
      this.config.RETENTION_BATCH,
      this.config.RETENTION_PER_WORKSPACE,
    );
    const now = this.clock();
    const totals = { conversations: 0, customers: 0 };
    for (const tenant of await retentionTenants(this.db)) {
      const [policy] = await withTenant(this.db, { tenantId: tenant.tenantId }, (tx) =>
        tx.select({ sweptAt: schema.retentionPolicies.sweptAt }).from(schema.retentionPolicies),
      );
      const full = !policy?.sweptAt || now.getTime() - policy.sweptAt.getTime() >= FULL_PASS_MS;
      const mine = due.filter((d) => d.tenantId === tenant.tenantId);
      if (mine.length === 0 && !full) continue;
      try {
        const done = await this.sweep({ ...tenant, due: mine, full });
        totals.conversations += done.conversations;
        totals.customers += done.customers;
      } catch (error) {
        this.logger.warn(`retention sweep failed for a workspace: ${String(error)}`);
      }
    }
    return totals;
  }

  private async sweep(pass: TenantPass): Promise<{ conversations: number; customers: number }> {
    const importers = new Map<string, Promise<ChatwootImporter>>();
    const importer = (connectionId: string) => {
      let found = importers.get(connectionId);
      if (!found) {
        found = this.registry
          .get(pass.tenantId, connectionId)
          .then((runtime) => importerFor(runtime, this.config));
        importers.set(connectionId, found);
      }
      return found;
    };
    const unavailable = new Set<string>();
    const deleted: string[] = [];
    let blocked = false;

    for (const item of pass.due) {
      if (blocked || unavailable.has(item.connectionId)) continue;
      const outcome = await this.retire(item, await importer(item.connectionId));
      if (outcome === 'deleted') deleted.push(item.conversationId);
      if (outcome === 'blocked') blocked = true;
      if (outcome === 'unavailable') unavailable.add(item.connectionId);
    }

    let history = 0;
    let customers = 0;
    if (pass.full && !blocked) {
      const found = await this.history(pass, importer, unavailable);
      history = found.deleted;
      blocked = found.blocked;
    }
    if (pass.full && !blocked) {
      const found = await this.customers(pass, importer, unavailable);
      customers = found.removed;
      blocked = found.blocked;
    }

    const conversations = deleted.length + history;
    const more = pass.due.length >= this.config.RETENTION_PER_WORKSPACE;
    const now = this.clock();
    await withTenant(this.db, { tenantId: pass.tenantId, actorId: 'retention' }, async (tx) => {
      const t = schema.retentionPolicies;
      await tx
        .update(t)
        .set({
          sweepState: blocked ? 'blocked' : more ? 'running' : 'idle',
          conversationsDeleted: sql`${t.conversationsDeleted} + ${conversations}`,
          customersDeleted: sql`${t.customersDeleted} + ${customers}`,
          ...(pass.full ? { sweptAt: now } : {}),
        })
        .where(eq(t.tenantId, pass.tenantId));
      if (conversations + customers > 0 || blocked) {
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'retention',
          action: 'privacy.retention_swept',
          targetType: 'tenant',
          targetId: toPublicId('tenant', pass.tenantId),
          outcome: blocked ? 'failed' : 'success',
          ...(blocked ? { reason: 'authority_not_admin' } : {}),
          data: {
            conversations,
            customers,
            ids: deleted.slice(0, 100).map((id) => toPublicId('conversation', id)),
          },
          occurredAt: now,
        });
      }
    });
    return { conversations, customers };
  }

  /** One conversation Hamnivo knows: checked here, deleted in the chat engine, then here. */
  private async retire(item: RetentionDue, importer: ChatwootImporter): Promise<Outcome> {
    const tenant = { tenantId: item.tenantId, actorId: 'retention' };
    const ready = await withTenant(this.db, tenant, async (tx) => {
      const c = schema.conversationControls;
      const [control] = await tx
        .select({ status: c.authorityStatus, at: c.lastActivityAt })
        .from(c)
        .where(eq(c.id, item.conversationId))
        .for('update');
      if (control?.status !== 'resolved' || control.at >= item.cutoff) return false;
      // A message still on its way to the chat engine is never cut off.
      const l = schema.messageLedger;
      const [sending] = await tx
        .select({ id: l.id })
        .from(l)
        .where(
          and(eq(l.conversationId, item.conversationId), inArray(l.state, ['pending', 'unknown'])),
        )
        .limit(1);
      return !sending;
    });
    if (!ready) return 'kept';
    try {
      const info = await importer.getConversation(item.externalConversationId);
      if (info) {
        // The chat engine is the record: a reopened or newer conversation there stays, and so
        // does one whose last activity it does not say.
        if (info.status !== 'resolved') return 'kept';
        if (!info.lastActivityAt || info.lastActivityAt >= item.cutoff) return 'kept';
        await importer.deleteConversation(item.externalConversationId);
      }
    } catch (error) {
      return outcomeOf(error);
    }
    const retired = await withTenant(this.db, tenant, (tx) =>
      retireConversation(tx, item.conversationId),
    );
    return retired ? 'deleted' : 'kept';
  }

  /**
   * Old resolved conversations only the chat engine has: imported history and chats Hamnivo never
   * followed, in this workspace's inboxes. Conversations Hamnivo knows are left to `retire`.
   */
  private async history(
    pass: TenantPass,
    importer: (connectionId: string) => Promise<ChatwootImporter>,
    unavailable: Set<string>,
  ): Promise<{ deleted: number; blocked: boolean }> {
    const inboxes = await withTenant(this.db, { tenantId: pass.tenantId }, (tx) =>
      tx
        .select({
          connectionId: schema.authorityInboxes.connectionId,
          externalInboxId: schema.authorityInboxes.externalInboxId,
        })
        .from(schema.authorityInboxes),
    );
    let deleted = 0;
    for (const inbox of inboxes) {
      if (unavailable.has(inbox.connectionId)) continue;
      const chatwoot = await importer(inbox.connectionId);
      try {
        pages: for (let page = 1; page <= HISTORY_PAGES; page += 1) {
          const { conversations } = await chatwoot.listConversations({
            page,
            inboxId: inbox.externalInboxId,
            status: 'resolved',
            leastRecentFirst: true,
          });
          if (conversations.length === 0) break;
          const known = new Set(
            (
              await withTenant(this.db, { tenantId: pass.tenantId }, (tx) =>
                tx
                  .select({ id: schema.conversationControls.externalConversationId })
                  .from(schema.conversationControls)
                  .where(
                    and(
                      eq(schema.conversationControls.connectionId, inbox.connectionId),
                      inArray(
                        schema.conversationControls.externalConversationId,
                        conversations.map((c) => c.id),
                      ),
                    ),
                  ),
              )
            ).map((row) => row.id),
          );
          for (const conversation of conversations) {
            const at = conversation.lastActivityAt;
            if (!at || at >= pass.cutoff) break pages;
            if (conversation.status !== 'resolved' || known.has(conversation.id)) continue;
            if (deleted >= this.config.RETENTION_PER_WORKSPACE) break pages;
            await chatwoot.deleteConversation(conversation.id);
            deleted += 1;
          }
          // Deletions move later conversations forward: what this pass skips, the next one finds.
        }
      } catch (error) {
        const outcome = outcomeOf(error);
        if (outcome === 'blocked') return { deleted, blocked: true };
        unavailable.add(inbox.connectionId);
      }
    }
    return { deleted, blocked: false };
  }

  /**
   * Customers left with no conversation, not seen since the cutoff: their chat engine contact
   * goes when it has no conversation left there either, then their memory, then the customer.
   */
  private async customers(
    pass: TenantPass,
    importer: (connectionId: string) => Promise<ChatwootImporter>,
    unavailable: Set<string>,
  ): Promise<{ removed: number; blocked: boolean }> {
    const tenant = { tenantId: pass.tenantId, actorId: 'retention' };
    const orphans = await withTenant(this.db, tenant, (tx) =>
      retentionOrphans(tx, this.config.RETENTION_PER_WORKSPACE),
    );
    let removed = 0;
    for (const orphan of orphans) {
      const contacts = await withTenant(this.db, tenant, (tx) =>
        tx
          .select({
            connectionId: schema.authorityContacts.connectionId,
            externalContactId: schema.authorityContacts.externalContactId,
          })
          .from(schema.authorityContacts)
          .where(eq(schema.authorityContacts.principalId, orphan.principalId)),
      );
      let reached = true;
      for (const contact of contacts) {
        if (contact.externalContactId === null) continue;
        if (unavailable.has(contact.connectionId)) {
          reached = false;
          continue;
        }
        const chatwoot = await importer(contact.connectionId);
        try {
          const left = await chatwoot.listContactConversations(contact.externalContactId);
          // Conversations of another brand or never followed keep the contact there.
          if (left.length === 0) await chatwoot.deleteContact(contact.externalContactId);
        } catch (error) {
          if (error instanceof ChatwootError && error.status === 404) continue;
          const outcome = outcomeOf(error);
          if (outcome === 'blocked') return { removed, blocked: true };
          unavailable.add(contact.connectionId);
          reached = false;
        }
      }
      if (!reached) continue;
      const gone = await withTenant(this.db, tenant, async (tx) => {
        await lockMemorySubject(tx, pass.tenantId, orphan.principalId);
        const records = await tx
          .select()
          .from(schema.memoryRecords)
          .where(eq(schema.memoryRecords.subjectId, orphan.principalId));
        if (records.length > 0) {
          await this.memory.delete(tx, {
            subject: { tenantId: pass.tenantId, id: orphan.principalId, brandId: orphan.brandId },
            records,
            scope: 'customer',
            reason: 'retention_expired',
            requestedBy: { type: 'system', id: null },
          });
        }
        return retireCustomer(tx, orphan.principalId);
      });
      if (gone) removed += 1;
    }
    return { removed, blocked: false };
  }
}
