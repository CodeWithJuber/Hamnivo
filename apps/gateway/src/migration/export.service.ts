import { createHash } from 'node:crypto';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { writePackage } from '@hamnivo/migration-sdk';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { AuthorityRegistry } from '../authority/registry.js';
import type { AppConfig } from '../config.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { readChatwootHistory } from './chatwoot-source.js';
import { importerFor } from './destination.js';

/** How long a generated package stays downloadable. */
const PACKAGE_HOURS = 24;
const MAX_CONVERSATIONS = 10_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;

/**
 * Export (M02): a brand's conversations, read from Chatwoot, written as a Hamnivo package: the same
 * format imports accept, so a tenant can leave Hamnivo with its history and files.
 */
@Injectable()
export class MigrationExporter {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly registry: AuthorityRegistry,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: 'migration-worker' }, work);
  }

  async onExport(event: ClaimedOutboxEvent): Promise<void> {
    const { jobId } = event.payload as { jobId: string };
    const tenantId = event.tenantId;
    const job = await this.tx(tenantId, async (tx) => {
      const [row] = await tx
        .update(schema.migrationJobs)
        .set({ state: 'running', startedAt: this.clock(), updatedAt: this.clock() })
        .where(and(eq(schema.migrationJobs.id, jobId), eq(schema.migrationJobs.state, 'queued')))
        .returning();
      return row ?? null;
    });
    if (!job?.connectionId) return;
    const connectionId = job.connectionId;
    try {
      const runtime = await this.registry.get(tenantId, connectionId);
      const inboxIds = await this.tx(tenantId, async (tx) =>
        (
          await tx
            .select({ externalInboxId: schema.authorityInboxes.externalInboxId })
            .from(schema.authorityInboxes)
            .where(
              and(
                eq(schema.authorityInboxes.connectionId, connectionId),
                eq(schema.authorityInboxes.brandId, job.brandId),
              ),
            )
        ).map((i) => i.externalInboxId),
      );
      const brandPublicId = toPublicId('brand', job.brandId);
      const history = await readChatwootHistory(importerFor(runtime, this.config), {
        inboxIds,
        system: 'chatwoot',
        brandPublicId,
        maxConversations: MAX_CONVERSATIONS,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
      });
      const now = this.clock();
      const missing = history.attachments.filter((a) => !a.bytes).length;
      const bytes = writePackage({
        source: { system: 'hamnivo', exportedAt: now.toISOString(), account: brandPublicId },
        generator: { name: 'Hamnivo', version: '1' },
        contacts: history.contacts,
        conversations: history.conversations,
        messages: history.messages,
        attachments: history.attachments,
        createdAt: now,
        complete: !history.truncated && missing === 0,
        notes: [
          ...(history.truncated ? [`Only the first ${MAX_CONVERSATIONS} conversations.`] : []),
          ...(missing > 0 ? [`${missing} files could not be downloaded.`] : []),
          ...(history.skippedActivity > 0
            ? [`${history.skippedActivity} activity events (status changes) are not included.`]
            : []),
        ],
      });
      if (bytes.byteLength > MAX_PACKAGE_BYTES) throw new Error('package_too_large');
      await this.tx(tenantId, async (tx) => {
        await tx.insert(schema.migrationFiles).values({
          tenantId,
          jobId: job.id,
          purpose: 'package',
          name: `hamnivo-export-${now.toISOString().slice(0, 10)}.zip`,
          mediaType: 'application/zip',
          byteSize: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest(),
          state: 'clean',
          raw: Buffer.from(bytes),
          purgeAfter: new Date(now.getTime() + PACKAGE_HOURS * 3_600_000),
        });
        await tx
          .update(schema.migrationJobs)
          .set({
            state: 'completed',
            finishedAt: now,
            updatedAt: now,
            stats: {
              found: {
                contacts: history.contacts.length,
                conversations: history.conversations.length,
                messages: history.messages.length,
                attachments: history.attachments.length,
              },
              truncated: history.truncated,
            },
          })
          .where(eq(schema.migrationJobs.id, job.id));
        await appendAudit(tx, {
          actorType: 'system',
          actorId: 'migration-worker',
          action: 'migration.export_ready',
          targetType: 'migration_job',
          targetId: toPublicId('migration', job.id),
          outcome: 'success',
          data: {
            conversations: history.conversations.length,
            messages: history.messages.length,
            bytes: bytes.byteLength,
          },
        });
      });
    } catch (error) {
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.migrationJobs)
          .set({
            state: 'failed',
            errorCode:
              error instanceof Error && error.message === 'package_too_large'
                ? 'too_large'
                : 'export_failed',
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, job.id)),
      );
    }
  }
}
