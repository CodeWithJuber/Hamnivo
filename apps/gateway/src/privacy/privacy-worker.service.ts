import { createHash } from 'node:crypto';
import { ChatwootError, type ChatwootImporter } from '@hamnivo/chatwoot';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  eraseCustomer,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { writeZip } from '@hamnivo/migration-sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import type { AppConfig } from '../config.js';
import { MemoryDeletionService } from '../memory/deletion.service.js';
import { lockMemorySubject } from '../memory/locks.js';
import { memoryValue } from '../memory/views.js';
import { importerFor } from '../migration/destination.js';
import type { Mailer } from '../platform/mailer.js';
import { senderNameOf } from '../platform/workspace-email.js';
import { APP_DB, CLOCK, type Clock, CONFIG, MAILER } from '../tokens.js';
import { IdentityFingerprints } from './identity-fingerprints.js';

/** An export's file is kept this long, then its bytes are cleared. */
const FILE_HOURS = 24;
/** The same limits as a brand's export package. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;
/** A request that failed this many times stops and says so. */
const MAX_ATTEMPTS = 10;

export const PRIVACY_REPLAY_TOPIC = 'privacy.replay';

type RequestRow = typeof schema.privacyRequests.$inferSelect;
type PrincipalRow = typeof schema.customerPrincipals.$inferSelect;

/** The chat engine refused because its Hamnivo user may not do this (not an administrator). */
class Blocked extends Error {}

function authorityFailure(error: unknown): never {
  if (error instanceof ChatwootError && (error.status === 401 || error.status === 403)) {
    throw new Blocked('authority_not_admin');
  }
  throw error;
}

interface Conversation {
  connectionId: string;
  externalId: number;
  /** Hamnivo's id when Hamnivo follows it. */
  id: string | null;
}

/** The customer, their brand's chat engine inboxes, contacts and conversations. */
interface Gathered {
  principal: PrincipalRow;
  brand: typeof schema.brands.$inferSelect;
  contacts: { connectionId: string; id: number }[];
  conversations: Conversation[];
  /** Each contact's profile in the chat engine, and the conversations it has in other brands. */
  profiles: {
    connectionId: string;
    id: number;
    name: string | null;
    email: string | null;
    phone: string | null;
    identifier: string | null;
    elsewhere: number;
  }[];
}

const json = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';

/**
 * One customer's data on request, in the worker (A10). An export reads Hamnivo and the chat engine
 * and writes a ZIP that is kept 24 hours. An erasure writes its tombstone first, deletes in the
 * chat engine, then the customer's memory through the memory deletion path, then everything else
 * in Hamnivo (app.erase_customer). Every step can run again; a request is retried by the outbox.
 */
@Injectable()
export class PrivacyWorker {
  private readonly logger = new Logger(PrivacyWorker.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly registry: AuthorityRegistry,
    private readonly memory: MemoryDeletionService,
    private readonly fingerprints: IdentityFingerprints,
  ) {}

  private importer(tenantId: string, connectionId: string): Promise<ChatwootImporter> {
    return this.registry
      .get(tenantId, connectionId)
      .then((runtime) => importerFor(runtime, this.config));
  }

  /** Takes the request to work on it, or null when it is done, stopped or not this kind. */
  private async claim(
    tenantId: string,
    requestId: string,
    kind: RequestRow['kind'],
  ): Promise<RequestRow | null> {
    return withTenant(this.db, { tenantId, actorId: 'privacy' }, async (tx) => {
      const t = schema.privacyRequests;
      const [row] = await tx
        .update(t)
        .set({ state: 'running', attempts: sql`${t.attempts} + 1`, updatedAt: this.clock() })
        .where(and(eq(t.id, requestId), eq(t.kind, kind), inArray(t.state, ['queued', 'running'])))
        .returning();
      if (row && row.attempts > MAX_ATTEMPTS) {
        await this.finish(tx, row, 'failed', row.counts, 'gave_up');
        return null;
      }
      return row ?? null;
    });
  }

  private async finish(
    tx: TenantTx,
    row: RequestRow,
    state: 'completed' | 'blocked' | 'failed',
    counts: Record<string, number>,
    problem: string | null,
  ) {
    const now = this.clock();
    await tx
      .update(schema.privacyRequests)
      .set({
        state,
        counts,
        problem,
        updatedAt: now,
        ...(state === 'completed' ? { completedAt: now } : {}),
      })
      .where(eq(schema.privacyRequests.id, row.id));
    await appendAudit(tx, {
      actorType: 'system',
      actorId: 'privacy',
      action:
        state === 'completed'
          ? row.kind === 'export'
            ? 'privacy.exported'
            : 'privacy.erased'
          : `privacy.${row.kind}_${state}`,
      targetType: 'customer',
      targetId: toPublicId('customer', row.principalId),
      outcome: state === 'completed' ? 'success' : 'failed',
      ...(problem ? { reason: problem } : {}),
      data: { requestId: toPublicId('privacyRequest', row.id), counts },
      occurredAt: now,
    });
  }

  /** Stops a request that the chat engine refused (until an owner fixes its user's role). */
  private async stop(tenantId: string, row: RequestRow, error: unknown): Promise<void> {
    if (!(error instanceof Blocked)) throw error;
    await withTenant(this.db, { tenantId, actorId: 'privacy' }, (tx) =>
      this.finish(tx, row, 'blocked', row.counts, error.message),
    );
  }

  /** The customer, and every conversation of theirs in the brand, in Hamnivo and in Chatwoot. */
  private async gather(tenantId: string, row: RequestRow): Promise<Gathered | null> {
    const local = await withTenant(this.db, { tenantId }, async (tx) => {
      const [found] = await tx
        .select({ principal: schema.customerPrincipals, brand: schema.brands })
        .from(schema.customerPrincipals)
        .innerJoin(schema.brands, eq(schema.brands.id, schema.customerPrincipals.brandId))
        .where(eq(schema.customerPrincipals.id, row.principalId));
      if (!found) return null;
      const contacts = await tx
        .select({
          connectionId: schema.authorityContacts.connectionId,
          id: schema.authorityContacts.externalContactId,
        })
        .from(schema.authorityContacts)
        .where(eq(schema.authorityContacts.principalId, row.principalId));
      const followed = await tx
        .select({
          id: schema.conversationControls.id,
          connectionId: schema.conversationControls.connectionId,
          externalId: schema.conversationControls.externalConversationId,
        })
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.principalId, row.principalId));
      const inboxes = await tx
        .select({
          connectionId: schema.authorityInboxes.connectionId,
          externalInboxId: schema.authorityInboxes.externalInboxId,
        })
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.brandId, found.brand.id));
      return { ...found, contacts, followed, inboxes };
    });
    if (!local) return null;
    const conversations = new Map<string, Conversation>(
      local.followed.map((c) => [`${c.connectionId}:${c.externalId}`, c]),
    );
    const profiles: Gathered['profiles'] = [];
    const contacts: Gathered['contacts'] = [];
    for (const contact of local.contacts) {
      if (contact.id === null) continue;
      contacts.push({ connectionId: contact.connectionId, id: contact.id });
      const chatwoot = await this.importer(tenantId, contact.connectionId);
      const mine = new Set(
        local.inboxes
          .filter((i) => i.connectionId === contact.connectionId)
          .map((i) => i.externalInboxId),
      );
      try {
        const profile = await chatwoot.getContact(contact.id);
        const theirs = profile ? await chatwoot.listContactConversations(contact.id) : [];
        for (const conversation of theirs) {
          if (!mine.has(conversation.inboxId)) continue;
          const key = `${contact.connectionId}:${conversation.id}`;
          if (!conversations.has(key)) {
            conversations.set(key, {
              connectionId: contact.connectionId,
              externalId: conversation.id,
              id: null,
            });
          }
        }
        if (profile) {
          profiles.push({
            connectionId: contact.connectionId,
            id: contact.id,
            name: profile.name,
            email: profile.email,
            phone: profile.phone,
            identifier: profile.identifier,
            elsewhere: theirs.filter((c) => !mine.has(c.inboxId)).length,
          });
        }
      } catch (error) {
        authorityFailure(error);
      }
    }
    return {
      principal: local.principal,
      brand: local.brand,
      contacts,
      conversations: [...conversations.values()],
      profiles,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Export

  async onExport(event: ClaimedOutboxEvent): Promise<void> {
    const { requestId } = event.payload as { requestId: string };
    const row = await this.claim(event.tenantId, requestId, 'export');
    if (!row) return;
    try {
      const gathered = await this.gather(event.tenantId, row);
      if (!gathered) {
        await withTenant(this.db, { tenantId: event.tenantId, actorId: 'privacy' }, (tx) =>
          this.finish(tx, row, 'failed', {}, 'customer_missing'),
        );
        return;
      }
      const { files, counts } = await this.build(event.tenantId, row, gathered);
      const zip = writeZip(files);
      const now = this.clock();
      const requester = await withTenant(
        this.db,
        { tenantId: event.tenantId, actorId: 'privacy' },
        async (tx) => {
          await tx
            .insert(schema.privacyFiles)
            .values({
              tenantId: event.tenantId,
              requestId: row.id,
              raw: Buffer.from(zip),
              sha256: sha256(zip),
              byteSize: zip.byteLength,
              purgeAfter: new Date(now.getTime() + FILE_HOURS * 3_600_000),
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: [schema.privacyFiles.tenantId, schema.privacyFiles.requestId],
              set: {
                raw: Buffer.from(zip),
                sha256: sha256(zip),
                byteSize: zip.byteLength,
                purgeAfter: new Date(now.getTime() + FILE_HOURS * 3_600_000),
              },
            });
          await this.finish(tx, row, 'completed', counts, null);
          return this.requester(tx, row);
        },
      );
      if (requester) {
        const url = `${this.config.PUBLIC_CONSOLE_ORIGIN.replace(/\/$/, '')}/settings/privacy`;
        await this.mailer
          .send({
            to: requester.email,
            template: 'privacy.export_ready',
            subject: `${requester.workspace}: a customer's data is ready to download`,
            text: [
              `The file with everything about customer ${toPublicId('customer', row.principalId)} is ready.`,
              '',
              `Download it in Studio within ${FILE_HOURS} hours; after that it is deleted:`,
              url,
            ].join('\n'),
            senderName: requester.senderName,
          })
          .catch((error: unknown) => this.logger.warn(`export email failed: ${String(error)}`));
      }
    } catch (error) {
      await this.stop(event.tenantId, row, error);
    }
  }

  private async requester(tx: TenantTx, row: RequestRow) {
    if (!row.requestedBy) return null;
    const [me] = await tx
      .select({ email: schema.staffMembers.email })
      .from(schema.staffMembers)
      .where(eq(schema.staffMembers.id, row.requestedBy));
    const [tenant] = await tx.select({ name: schema.tenants.name }).from(schema.tenants);
    if (!me) return null;
    return {
      email: me.email,
      workspace: tenant?.name ?? 'Your workspace',
      senderName: await senderNameOf(tx),
    };
  }

  /** The files of the export: JSON documents and the customer's files, within the size limits. */
  private async build(tenantId: string, row: RequestRow, gathered: Gathered) {
    const files = new Map<string, Uint8Array>();
    const left: { path: string; reason: string }[] = [];
    const counts: Record<string, number> = {
      conversations: 0,
      messages: 0,
      files: 0,
      filesLeftOut: 0,
    };
    let total = 0;
    const { principal, brand } = gathered;

    const local = await withTenant(this.db, { tenantId }, async (tx) => ({
      chatConsents: await tx
        .select()
        .from(schema.chatConsents)
        .where(eq(schema.chatConsents.principalId, principal.id)),
      learningConsents: await tx
        .select()
        .from(schema.learningConsents)
        .where(eq(schema.learningConsents.subjectId, principal.id)),
      memories: await tx
        .select()
        .from(schema.memoryRecords)
        .where(eq(schema.memoryRecords.subjectId, principal.id)),
      orders: await tx
        .select()
        .from(schema.orders)
        .where(eq(schema.orders.principalId, principal.id)),
      feedback: await tx
        .select()
        .from(schema.conversationFeedback)
        .where(eq(schema.conversationFeedback.principalId, principal.id)),
      notifications: await tx
        .select()
        .from(schema.customerNotificationPreferences)
        .where(eq(schema.customerNotificationPreferences.principalId, principal.id)),
      language: await tx
        .select()
        .from(schema.languagePreferences)
        .where(eq(schema.languagePreferences.principalId, principal.id)),
    }));

    files.set(
      'customer.json',
      json({
        id: toPublicId('customer', principal.id),
        brand: brand.name,
        kind: principal.kind,
        name: principal.displayName,
        email: principal.email,
        idInYourSystems: principal.externalSubject,
        channel: principal.channelKind
          ? { kind: principal.channelKind, handle: principal.channelHandle }
          : null,
        language: principal.locale,
        firstSeen: principal.createdAt.toISOString(),
        lastSeen: principal.lastSeenAt?.toISOString() ?? null,
        inChatwoot: gathered.profiles.map((p) => ({
          name: p.name,
          email: p.email,
          phone: p.phone,
          identifier: p.identifier,
        })),
      }),
    );

    for (const conversation of gathered.conversations) {
      const chatwoot = await this.importer(tenantId, conversation.connectionId);
      let messages: Awaited<ReturnType<ChatwootImporter['listMessages']>> = [];
      try {
        messages = await chatwoot.listMessages(conversation.externalId);
      } catch (error) {
        if (error instanceof ChatwootError && error.status === 404) continue;
        authorityFailure(error);
      }
      const name = conversation.id
        ? toPublicId('conversation', conversation.id)
        : `chatwoot-${conversation.externalId}`;
      const shown = [];
      // What the customer saw: their messages and the replies, never internal notes or activity.
      for (const message of messages) {
        if (message.private) continue;
        if (message.direction !== 'incoming' && message.direction !== 'outgoing') continue;
        const attachments = [];
        for (const [index, attachment] of message.attachments.slice(0, 20).entries()) {
          const fileName = safeName(attachment.name ?? `${attachment.fileType}-${index + 1}`);
          const path = `attachments/${name}/${message.ref}-${fileName}`;
          if (!attachment.url) {
            attachments.push({ name: fileName, included: false });
            continue;
          }
          if ((attachment.size ?? 0) > MAX_FILE_BYTES || total >= MAX_PACKAGE_BYTES) {
            left.push({ path, reason: 'too_large' });
            counts.filesLeftOut = (counts.filesLeftOut ?? 0) + 1;
            attachments.push({ name: fileName, included: false });
            continue;
          }
          const bytes = await chatwoot.download(attachment.url, MAX_FILE_BYTES).catch(() => null);
          if (!bytes || total + bytes.byteLength > MAX_PACKAGE_BYTES) {
            left.push({ path, reason: bytes ? 'too_large' : 'unavailable' });
            counts.filesLeftOut = (counts.filesLeftOut ?? 0) + 1;
            attachments.push({ name: fileName, included: false });
            continue;
          }
          total += bytes.byteLength;
          files.set(path, bytes);
          counts.files = (counts.files ?? 0) + 1;
          attachments.push({ name: fileName, included: true, file: path });
        }
        shown.push({
          at: message.createdAt.toISOString(),
          from: message.direction === 'incoming' ? 'customer' : 'business',
          text: message.text,
          attachments,
        });
      }
      counts.conversations = (counts.conversations ?? 0) + 1;
      counts.messages = (counts.messages ?? 0) + shown.length;
      files.set(`conversations/${name}.json`, json({ id: name, messages: shown }));
    }

    files.set(
      'consents.json',
      json({
        beforeChatting: local.chatConsents.map((c) => ({
          wordingVersion: c.noticeVersion,
          at: c.createdAt.toISOString(),
        })),
        memoryAndLearning: local.learningConsents.map((c) => ({
          scope: c.scope,
          state: c.state,
          wordingVersion: c.noticeVersion,
          by: c.actorType,
          at: c.createdAt.toISOString(),
        })),
      }),
    );
    files.set(
      'memory.json',
      json(
        local.memories.map((m) => ({
          key: m.key,
          value: memoryValue(m),
          status: m.status,
          noticed: m.observedAt.toISOString(),
          forgottenOn: m.expiresAt?.toISOString() ?? null,
        })),
      ),
    );
    files.set(
      'orders.json',
      json(
        local.orders.map((o) => ({
          reference: o.reference,
          state: o.state,
          payment: o.paymentState,
          fulfillment: o.fulfillmentState,
          currency: o.currency,
          totalMinor: o.totalMinor.toString(),
          lines: o.lines,
          delivery: o.deliverySummary,
          placedAt: o.placedAt.toISOString(),
        })),
      ),
    );
    files.set(
      'feedback.json',
      json(
        local.feedback.map((f) => ({
          rating: f.rating,
          comment: f.comment,
          at: f.createdAt.toISOString(),
        })),
      ),
    );
    files.set(
      'preferences.json',
      json({ notifications: local.notifications[0] ?? null, language: local.language[0] ?? null }),
    );
    counts.memories = local.memories.length;
    counts.orders = local.orders.length;

    const manifest = {
      exportedAt: this.clock().toISOString(),
      request: toPublicId('privacyRequest', row.id),
      customer: toPublicId('customer', principal.id),
      counts,
      leftOut: left,
      files: [...files].map(([path, bytes]) => ({
        path,
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      })),
    };
    files.set('manifest.json', json(manifest));
    files.set(
      'README.txt',
      new TextEncoder().encode(
        [
          `Everything ${brand.name} keeps about customer ${toPublicId('customer', principal.id)}, exported ${manifest.exportedAt}.`,
          '',
          'customer.json      who the customer is, here and in the chat engine',
          'conversations/     each conversation as the customer saw it (internal notes are not included)',
          'attachments/       the files sent in those conversations',
          'consents.json      what the customer agreed to, and when',
          'memory.json        what the AI assistant remembered about them',
          'orders.json        their orders',
          'feedback.json      their ratings',
          'preferences.json   their email and language choices',
          'manifest.json      every file with its size and SHA-256, and anything left out',
          '',
        ].join('\n'),
      ),
    );
    return { files, counts };
  }

  // ---------------------------------------------------------------------------------------------
  // Erase

  async onErase(event: ClaimedOutboxEvent): Promise<void> {
    const { requestId } = event.payload as { requestId: string };
    const row = await this.claim(event.tenantId, requestId, 'erase');
    if (!row) return;
    const tenant = { tenantId: event.tenantId, actorId: 'privacy' };
    try {
      const gathered = await this.gather(event.tenantId, row);
      if (!gathered) {
        await withTenant(this.db, tenant, (tx) =>
          this.finish(tx, row, 'completed', { customerAlreadyGone: 1 }, null),
        );
        return;
      }
      // 1. What it erases is written down first, so a restore or an import cannot bring it back.
      await withTenant(this.db, tenant, async (tx) => {
        await tx
          .insert(schema.erasureTombstones)
          .values({
            tenantId: event.tenantId,
            requestId: row.id,
            brandId: gathered.brand.id,
            principalId: gathered.principal.id,
            authority: {
              contacts: gathered.contacts,
              conversations: gathered.conversations.map((c) => ({
                connectionId: c.connectionId,
                id: c.externalId,
              })),
            } satisfies schema.ErasedAuthorityItems,
            fingerprints: this.identity(event.tenantId, gathered),
            createdAt: this.clock(),
          })
          .onConflictDoNothing();
        // 2. The customer's chat sessions end now.
        await tx
          .update(schema.widgetSessions)
          .set({ revokedAt: this.clock(), revokeReason: 'erased' })
          .where(
            and(
              eq(schema.widgetSessions.principalId, gathered.principal.id),
              isNull(schema.widgetSessions.revokedAt),
            ),
          );
      });

      // 3. The chat engine: the conversations, then each contact no other brand still uses.
      const counts: Record<string, number> = {
        chatwootConversations: 0,
        chatwootContacts: 0,
        chatwootContactsKept: 0,
      };
      for (const conversation of gathered.conversations) {
        const chatwoot = await this.importer(event.tenantId, conversation.connectionId);
        const gone = await chatwoot
          .deleteConversation(conversation.externalId)
          .catch(authorityFailure);
        if (gone === 'deleted')
          counts.chatwootConversations = (counts.chatwootConversations ?? 0) + 1;
      }
      for (const profile of gathered.profiles) {
        if (profile.elsewhere > 0) {
          counts.chatwootContactsKept = (counts.chatwootContactsKept ?? 0) + 1;
          continue;
        }
        const chatwoot = await this.importer(event.tenantId, profile.connectionId);
        const gone = await chatwoot.deleteContact(profile.id).catch(authorityFailure);
        if (gone === 'deleted') counts.chatwootContacts = (counts.chatwootContacts ?? 0) + 1;
      }

      // 4. Memory, with its own receipt and tombstones; 5. everything else in Hamnivo.
      const result = await withTenant(this.db, tenant, async (tx) => {
        await lockMemorySubject(tx, event.tenantId, gathered.principal.id);
        const records = await tx
          .select()
          .from(schema.memoryRecords)
          .where(eq(schema.memoryRecords.subjectId, gathered.principal.id));
        if (records.length > 0) {
          await this.memory.delete(tx, {
            subject: {
              tenantId: event.tenantId,
              id: gathered.principal.id,
              brandId: gathered.brand.id,
            },
            records,
            scope: 'customer',
            reason: 'erasure_request',
            requestedBy: {
              type: row.requestedBy ? 'staff' : 'system',
              id: row.requestedBy ? toPublicId('staff', row.requestedBy) : null,
            },
          });
        }
        const erased = await eraseCustomer(tx, row.id);
        if (erased.customer === 'memory_left') throw new Error('memory still being deleted');
        const done = {
          ...counts,
          conversations: erased.conversations,
          memories: records.length,
          customerDeleted: erased.customer === 'deleted' ? 1 : 0,
          customerAnonymised: erased.customer === 'anonymised' ? 1 : 0,
        };
        await this.finish(tx, row, 'completed', done, null);
        return done;
      });
      this.logger.log(`customer erased: ${JSON.stringify(result)}`);
    } catch (error) {
      await this.stop(event.tenantId, row, error);
    }
  }

  /** Fingerprints of everything that identified the customer, here and in the chat engine. */
  private identity(tenantId: string, gathered: Gathered): string[] {
    const scope = { tenantId, brandId: gathered.brand.id };
    const { principal } = gathered;
    return [
      ...new Set([
        ...this.fingerprints.current(scope, {
          subject: principal.externalSubject,
          email: principal.email,
          handle: principal.channelHandle,
        }),
        ...gathered.profiles.flatMap((p) =>
          this.fingerprints.current(scope, {
            email: p.email,
            phone: p.phone,
            identifier: p.identifier,
          }),
        ),
      ]),
    ];
  }

  // ---------------------------------------------------------------------------------------------
  // After a restore

  /**
   * A restore brought an erased customer back (app.apply_erasure_tombstones erased them again in
   * Hamnivo): their chat engine contact and conversations go again too, but only where the contact
   * still matches what the tombstone recorded, because a restored chat engine reuses ids.
   */
  async onReplay(event: ClaimedOutboxEvent): Promise<void> {
    const { tombstoneId } = event.payload as { tombstoneId: string };
    const [tombstone] = await withTenant(this.db, { tenantId: event.tenantId }, (tx) =>
      tx
        .select()
        .from(schema.erasureTombstones)
        .where(eq(schema.erasureTombstones.id, tombstoneId)),
    );
    if (!tombstone) return;
    const known = new Set(tombstone.fingerprints);
    const scope = { tenantId: event.tenantId, brandId: tombstone.brandId };
    const matches = (contact: {
      email: string | null;
      phone: string | null;
      identifier: string | null;
    }) =>
      this.fingerprints
        .all(scope, { email: contact.email, phone: contact.phone, identifier: contact.identifier })
        .some((f) => known.has(f));
    for (const contact of tombstone.authority.contacts) {
      const chatwoot = await this.importer(event.tenantId, contact.connectionId);
      const found = await chatwoot.getContact(contact.id);
      // Deleting the contact deletes its conversations with it.
      if (found && matches(found)) await chatwoot.deleteContact(contact.id);
    }
    for (const conversation of tombstone.authority.conversations) {
      const chatwoot = await this.importer(event.tenantId, conversation.connectionId);
      const found = await chatwoot.getConversation(conversation.id);
      if (!found?.contactId) continue;
      const contact = await chatwoot.getContact(found.contactId);
      if (contact && matches(contact)) await chatwoot.deleteConversation(conversation.id);
    }
  }
}
