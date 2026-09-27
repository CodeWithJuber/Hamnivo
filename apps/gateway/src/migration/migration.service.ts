import { createHash } from 'node:crypto';
import {
  type ApproveCutoverRequest,
  type CreateMigrationRequest,
  MIGRATION_MAX_BYTES,
  type MigrationItem,
  type MigrationItemQuery,
  type MigrationJob,
  type MigrationReport,
  type MigrationSample,
  type MigrationSourceInfo,
  type StartMigrationRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  InvalidPublicIdError,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  importMessageKey,
  isZip,
  PackageError,
  packageDescriptor,
  redact,
  type SourceSystem,
  tawkDescriptor,
} from '@hamnivo/migration-sdk';
import { authorize, type Permission, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { AuthorityRegistry } from '../authority/registry.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import {
  brandConnectionId,
  destinationChecks,
  importerFor,
  importInboxOf,
  readUpload,
} from './destination.js';
import {
  type Checkpoint,
  itemView,
  type JobRow,
  jobViews,
  latestReport,
  reportView,
} from './views.js';

type Actionable = 'start' | 'pause' | 'resume' | 'cancel' | 'retry' | 'rollback' | 'cutover';

/** Reasons a retry can fix: outages and objects that were never reached because of them. */
const RETRYABLE = [
  'authority_unavailable',
  'authority_rejected',
  'parent_failed',
  'scan_unavailable',
];

function csvCell(value: string | null | undefined): string {
  const text = value ?? '';
  // A leading =, +, - or @ makes spreadsheets run the cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function mediaTypeOf(bytes: Uint8Array, name: string): string {
  if (isZip(bytes)) return 'application/zip';
  return /\.(ndjson|jsonl)$/i.test(name) ? 'application/x-ndjson' : 'application/json';
}

/**
 * Migration administration (M01–M08): uploads go to quarantine and are checked by the worker;
 * dry runs, imports, pauses, cancellations, retries, rollbacks and cutover approvals are staff
 * actions authorized per brand and audited. Nothing here writes to Chatwoot.
 */
@Injectable()
export class MigrationService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: AuthorityRegistry,
  ) {}

  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private allowed(
    principal: StaffPrincipal,
    permission: Permission,
    resource: { workspaceId: string; brandId: string },
  ) {
    return authorize(principal, permission, resource, {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    });
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    job: JobRow,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'migration_job',
      targetId: toPublicId('migration', job.id),
      outcome: 'success',
      data,
    });
  }

  private async load(
    tx: TenantTx,
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
    lock = false,
  ): Promise<JobRow> {
    let id: string;
    try {
      id = fromPublicId('migration', publicId);
    } catch (error) {
      if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
      throw error;
    }
    const query = tx.select().from(schema.migrationJobs).where(eq(schema.migrationJobs.id, id));
    const [job] = lock ? await query.for('update') : await query;
    // Another tenant's job is invisible here (row-level security): the same answer as none.
    if (!job) throw new AppError('NOT_FOUND', { detail: 'Migration not found.' });
    enforce(this.allowed(principal, permission, job));
    return job;
  }

  private async view(tx: TenantTx, job: JobRow): Promise<MigrationJob> {
    const [view] = await jobViews(tx, [job]);
    if (!view) throw new Error('job view missing');
    return view;
  }

  private queue(tx: TenantTx, job: JobRow, topic: string) {
    return enqueueOutbox(tx, job.tenantId, {
      topic,
      aggregateType: 'migration_job',
      aggregateId: job.id,
      payload: { jobId: job.id },
    });
  }

  sources(): MigrationSourceInfo[] {
    return [
      { ...tawkDescriptor, available: true },
      { ...packageDescriptor, available: true },
    ].map((d) => ({
      system: d.system,
      accepts: d.accepts,
      available: d.available,
      fields: d.fields.map((f) => ({
        source: f.source,
        target: f.target,
        status: f.status,
        ...(f.required ? { required: true } : {}),
      })),
      limits: d.limits,
    }));
  }

  async list(principal: StaffPrincipal): Promise<MigrationJob[]> {
    return this.tx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.migrationJobs)
        .orderBy(desc(schema.migrationJobs.createdAt))
        .limit(100);
      const visible = rows.filter(
        (row) => this.allowed(principal, 'migration.review', row).allowed,
      );
      return jobViews(tx, visible);
    });
  }

  async get(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.tx(principal, async (tx) =>
      this.view(tx, await this.load(tx, principal, publicId, 'migration.review')),
    );
  }

  /** Stores the upload in quarantine and queues the scan and preflight. */
  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateMigrationRequest>,
  ): Promise<MigrationJob> {
    const bytes = Buffer.from(input.file.base64, 'base64');
    if (bytes.byteLength === 0) {
      throw new AppError('VALIDATION_FAILED', { detail: 'The file is empty.' });
    }
    if (bytes.byteLength > MIGRATION_MAX_BYTES) {
      throw new AppError('UPLOAD_TOO_LARGE', { detail: 'Exports can be up to 20 MB.' });
    }
    const brandId = fromPublicId('brand', input.brandId);
    const name = input.file.name.replace(/[\\/]/g, '_').slice(0, 200);
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'migration.run', { workspaceId: brand.workspaceId, brandId }),
      );
      const [job] = await tx
        .insert(schema.migrationJobs)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          sourceSystem: input.source,
          sourceKind: 'file',
          label: name,
          state: 'scanning',
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!job) throw new Error('job insert returned nothing');
      await tx.insert(schema.migrationFiles).values({
        tenantId: principal.tenantId,
        jobId: job.id,
        purpose: 'export',
        name,
        mediaType: mediaTypeOf(bytes, name),
        byteSize: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest(),
        raw: bytes,
        createdBy: principal.staffMemberId,
      });
      await this.queue(tx, job, 'migration.scan');
      await this.audit(tx, principal, 'migration.created', job, {
        source: input.source,
        file: name,
        bytes: bytes.byteLength,
        brandId: input.brandId,
      });
      return this.view(tx, job);
    });
  }

  /** Runs the checks again (for example after an automation was turned off in Chatwoot). */
  async recheck(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['ready', 'blocked', 'dry_run_ready'],
      async (tx, job) => {
        await tx
          .update(schema.migrationJobs)
          .set({ state: 'scanning', updatedAt: this.clock() })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.queue(tx, job, 'migration.scan');
        return 'migration.recheck_requested';
      },
    );
  }

  async dryRun(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['ready', 'dry_run_ready'],
      async (tx, job) => {
        await tx
          .update(schema.migrationJobs)
          .set({ state: 'dry_running', updatedAt: this.clock() })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.queue(tx, job, 'migration.dry_run');
        return 'migration.dry_run_requested';
      },
    );
  }

  /** Starts the import after a dry run, once the destination checks pass again right now. */
  async start(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof StartMigrationRequest>,
  ): Promise<MigrationJob> {
    const job = await this.tx(principal, (tx) =>
      this.load(tx, principal, publicId, 'migration.run'),
    );
    this.expectState(job, ['dry_run_ready'], 'start');
    const destination = await this.tx(principal, async (tx) => {
      const connectionId = await brandConnectionId(tx, job.brandId);
      return {
        connectionId,
        importInbox: connectionId ? await importInboxOf(tx, connectionId, job.brandId) : null,
      };
    });
    if (!destination.connectionId) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Connect Chatwoot for this brand before importing.',
      });
    }
    const runtime = await this.registry.get(principal.tenantId, destination.connectionId);
    const checks = await destinationChecks(
      importerFor(runtime, this.config),
      destination.importInbox,
    );
    const blocked = checks.filter((c) => c.status === 'blocked');
    if (blocked.length > 0 || (job.preflight as { blocking?: boolean } | null)?.blocking) {
      throw new AppError('VALIDATION_FAILED', {
        detail: `The import cannot start: ${blocked.map((c) => c.code).join(', ') || 'the preflight found blocking problems'}.`,
      });
    }
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['dry_run_ready'],
      async (tx, row) => {
        await tx
          .update(schema.migrationJobs)
          .set({
            state: 'queued',
            connectionId: destination.connectionId,
            options: { ...(row.options as object), duplicates: input.duplicates },
            errorCode: null,
            errorDetail: null,
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, row.id));
        await this.queue(tx, row, 'migration.run');
        return 'migration.started';
      },
    );
  }

  async pause(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['queued', 'running'],
      async (tx, job) => {
        await tx
          .update(schema.migrationJobs)
          .set(
            job.state === 'queued'
              ? { state: 'paused', updatedAt: this.clock() }
              : { requestedAction: 'pause', updatedAt: this.clock() },
          )
          .where(eq(schema.migrationJobs.id, job.id));
        return 'migration.pause_requested';
      },
    );
  }

  async resume(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['paused', 'failed'],
      async (tx, job) => {
        if (!job.connectionId)
          throw new AppError('VALIDATION_FAILED', { detail: 'Start the import first.' });
        await tx
          .update(schema.migrationJobs)
          .set({
            state: 'queued',
            requestedAction: null,
            errorCode: null,
            errorDetail: null,
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.queue(tx, job, 'migration.run');
        return 'migration.resumed';
      },
    );
  }

  /** Stops at the next checkpoint; what was imported stays until rolled back. */
  async cancel(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['queued', 'running', 'paused', 'failed', 'ready', 'dry_run_ready', 'blocked'],
      async (tx, job) => {
        if (['ready', 'dry_run_ready', 'blocked'].includes(job.state) || !job.connectionId) {
          // Nothing was imported yet: the job simply ends.
          await tx
            .update(schema.migrationJobs)
            .set({ state: 'cancelled', finishedAt: this.clock(), updatedAt: this.clock() })
            .where(eq(schema.migrationJobs.id, job.id));
          await tx
            .update(schema.migrationFiles)
            .set({ purgeAfter: this.clock() })
            .where(eq(schema.migrationFiles.jobId, job.id));
          return 'migration.cancelled';
        }
        await tx
          .update(schema.migrationJobs)
          .set({
            requestedAction: 'cancel',
            ...(job.state === 'running' ? {} : { state: 'queued' as const }),
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, job.id));
        if (job.state !== 'running') await this.queue(tx, job, 'migration.run');
        return 'migration.cancel_requested';
      },
    );
  }

  /** Retries only what failed; imported objects are never sent again. */
  async retry(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.run',
      ['completed', 'failed'],
      async (tx, job) => {
        const failed = await tx
          .select({
            id: schema.migrationItems.id,
            conversationSourceId: schema.migrationItems.conversationSourceId,
          })
          .from(schema.migrationItems)
          .where(
            and(
              eq(schema.migrationItems.jobId, job.id),
              eq(schema.migrationItems.status, 'failed'),
              inArray(schema.migrationItems.reason, RETRYABLE),
            ),
          );
        if (failed.length === 0 && job.state === 'completed') {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'Nothing failed that a retry could fix.',
          });
        }
        await tx
          .update(schema.migrationItems)
          .set({
            status: 'pending',
            attempts: 0,
            reason: null,
            detail: null,
            updatedAt: this.clock(),
          })
          .where(
            and(
              eq(schema.migrationItems.jobId, job.id),
              eq(schema.migrationItems.status, 'failed'),
              inArray(schema.migrationItems.reason, RETRYABLE),
            ),
          );
        // Conversations with retried messages are finished again, from their first open message.
        const conversations = [
          ...new Set(failed.map((f) => f.conversationSourceId).filter(Boolean)),
        ];
        if (conversations.length > 0) {
          await tx
            .update(schema.migrationItems)
            .set({ status: 'writing', updatedAt: this.clock() })
            .where(
              and(
                eq(schema.migrationItems.jobId, job.id),
                eq(schema.migrationItems.kind, 'conversation'),
                eq(schema.migrationItems.status, 'imported'),
                inArray(schema.migrationItems.sourceId, conversations as string[]),
              ),
            );
        }
        await tx
          .update(schema.migrationJobs)
          .set({
            state: 'queued',
            checkpoint: { ...(job.checkpoint as Checkpoint), index: 0 },
            errorCode: null,
            errorDetail: null,
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.queue(tx, job, 'migration.run');
        return 'migration.retry_requested';
      },
    );
  }

  /** Removes what this import created; allowed until cutover is approved. */
  async rollback(principal: StaffPrincipal, publicId: string): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.manage',
      ['completed', 'cancelled', 'failed', 'paused'],
      async (tx, job) => {
        if (!job.connectionId) {
          throw new AppError('VALIDATION_FAILED', { detail: 'Nothing was imported to roll back.' });
        }
        await tx
          .update(schema.migrationJobs)
          .set({ state: 'rolling_back', requestedAction: null, updatedAt: this.clock() })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.queue(tx, job, 'migration.rollback');
        return 'migration.rollback_requested';
      },
    );
  }

  /** Approves the reconciled import and closes the job; a failed check needs acknowledging. */
  async cutover(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof ApproveCutoverRequest>,
  ): Promise<MigrationJob> {
    return this.transition(
      principal,
      publicId,
      'migration.manage',
      ['completed'],
      async (tx, job) => {
        const report = await latestReport(tx, job.id);
        if (!report)
          throw new AppError('VALIDATION_FAILED', { detail: 'The import has no report yet.' });
        if (report.gate === 'failed' && !input.acknowledgeFailedChecks) {
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Some reconciliation checks failed. Confirm that you accept them to approve.',
            fields: [{ path: 'acknowledgeFailedChecks', message: 'Required when a check failed' }],
          });
        }
        const now = this.clock();
        await tx
          .update(schema.reconciliationReports)
          .set({
            approvedBy: principal.staffMemberId,
            approvedAt: now,
            acknowledged: report.gate === 'failed',
          })
          .where(eq(schema.reconciliationReports.id, report.id));
        await tx
          .update(schema.migrationJobs)
          .set({ state: 'closed', closedAt: now, updatedAt: now })
          .where(eq(schema.migrationJobs.id, job.id));
        // The raw export is no longer needed once the import is accepted.
        await tx
          .update(schema.migrationFiles)
          .set({ purgeAfter: now })
          .where(eq(schema.migrationFiles.jobId, job.id));
        return 'migration.cutover_approved';
      },
    );
  }

  private expectState(job: JobRow, states: JobRow['state'][], action: Actionable | string) {
    if (!states.includes(job.state)) {
      throw new AppError('VERSION_CONFLICT', {
        detail: `This migration is ${job.state.replaceAll('_', ' ')}; it cannot ${action} now.`,
      });
    }
  }

  private async transition(
    principal: StaffPrincipal,
    publicId: string,
    permission: Permission,
    states: JobRow['state'][],
    work: (tx: TenantTx, job: JobRow) => Promise<string>,
  ): Promise<MigrationJob> {
    return this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, permission, true);
      this.expectState(job, states, permission);
      const action = await work(tx, job);
      await this.audit(tx, principal, action, job, { from: job.state });
      const [fresh] = await tx
        .select()
        .from(schema.migrationJobs)
        .where(eq(schema.migrationJobs.id, job.id));
      return this.view(tx, fresh ?? job);
    });
  }

  async items(
    principal: StaffPrincipal,
    publicId: string,
    query: z.output<typeof MigrationItemQuery>,
  ): Promise<{ items: MigrationItem[]; nextCursor: string | null }> {
    return this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, 'migration.review');
      const conditions: SQL[] = [eq(schema.migrationItems.jobId, job.id)];
      if (query.kind) conditions.push(eq(schema.migrationItems.kind, query.kind));
      if (query.status === 'problems') {
        conditions.push(inArray(schema.migrationItems.status, ['failed', 'quarantined']));
      } else if (query.status) {
        conditions.push(eq(schema.migrationItems.status, query.status));
      }
      if (query.cursor) {
        if (!/^[0-9a-f-]{36}$/.test(query.cursor)) throw new AppError('VALIDATION_FAILED');
        conditions.push(gt(schema.migrationItems.id, query.cursor));
      }
      const rows = await tx
        .select()
        .from(schema.migrationItems)
        .where(and(...conditions))
        .orderBy(asc(schema.migrationItems.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(itemView),
        nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      };
    });
  }

  /** Objects that were not imported, with reasons (a CSV people can open in a spreadsheet). */
  async rejections(principal: StaffPrincipal, publicId: string): Promise<string> {
    return this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, 'migration.review');
      const rows = await tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, job.id),
            inArray(schema.migrationItems.status, [
              'failed',
              'quarantined',
              'skipped',
              'pending',
              'writing',
            ]),
          ),
        )
        .orderBy(asc(schema.migrationItems.kind), asc(schema.migrationItems.id));
      const header = 'kind,source_id,conversation_source_id,status,reason,detail\n';
      return (
        header +
        rows
          .map((r) =>
            [r.kind, r.sourceId, r.conversationSourceId, r.status, r.reason, r.detail]
              .map(csvCell)
              .join(','),
          )
          .join('\n') +
        (rows.length > 0 ? '\n' : '')
      );
    });
  }

  async reports(principal: StaffPrincipal, publicId: string): Promise<MigrationReport[]> {
    return this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, 'migration.review');
      const rows = await tx
        .select()
        .from(schema.reconciliationReports)
        .where(eq(schema.reconciliationReports.jobId, job.id))
        .orderBy(sql`${schema.reconciliationReports.createdAt} desc`);
      return rows.map(reportView);
    });
  }

  /**
   * One conversation of the export beside what Chatwoot now holds, both redacted: authors, order,
   * original times, privacy and files can be compared (the sample review, M08).
   */
  async sample(
    principal: StaffPrincipal,
    publicId: string,
    conversationSourceId: string,
  ): Promise<MigrationSample> {
    const loaded = await this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, 'migration.review');
      const [file] = await tx
        .select()
        .from(schema.migrationFiles)
        .where(
          and(
            eq(schema.migrationFiles.jobId, job.id),
            eq(schema.migrationFiles.purpose, 'export'),
            isNotNull(schema.migrationFiles.raw),
          ),
        );
      const items = await tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, job.id),
            eq(schema.migrationItems.conversationSourceId, conversationSourceId),
          ),
        );
      return { job, file: file ?? null, items };
    });
    const { job, file, items } = loaded;
    if (!file?.raw) {
      throw new AppError('NOT_FOUND', {
        detail: 'The export was removed after the retention period, so samples are not available.',
      });
    }
    let parsed: ReturnType<typeof readUpload>['parsed'];
    try {
      parsed = readUpload(file, file.raw, job.sourceSystem as SourceSystem).parsed;
    } catch (error) {
      if (error instanceof PackageError) throw new AppError('NOT_FOUND');
      throw error;
    }
    const conversation = parsed.conversations.find((c) => c.record.id === conversationSourceId);
    if (!conversation) throw new AppError('NOT_FOUND', { detail: 'Conversation not found.' });
    const contact = parsed.contacts.find((c) => c.id === conversation.record.contactId);
    const status = (kind: string, sourceId: string) =>
      items.find((i) => i.kind === kind && i.sourceId === sourceId);
    const jobKey = toPublicId('migration', job.id);
    const source: MigrationSample['source'] = {
      sourceId: conversation.record.id,
      startedAt: conversation.record.startedAt,
      contactName: contact?.name ? redact(contact.name) : null,
      messages: conversation.messages.map((m) => ({
        sourceId: m.id,
        author: { kind: m.author.kind, name: m.author.name ?? null },
        visibility: m.visibility,
        text: m.text ? redact(m.text) : null,
        createdAt: m.createdAt,
        importedAt: null,
        attachments: m.attachmentIds.map((id) => {
          const item = status('attachment', id);
          const attachment = parsed.attachments.get(id);
          // Before the import, a file the export can't provide is shown as it will be treated.
          const planned = attachment ? attachment.problem : 'missing_attachment';
          return {
            name: attachment?.entry.name ?? 'file',
            status: item?.status ?? (planned ? 'quarantined' : 'pending'),
            reason: item?.reason ?? planned ?? null,
          };
        }),
      })),
    };
    const target = status('conversation', conversationSourceId)?.targetRef;
    if (!target || !job.connectionId) return { source, imported: null, comparison: null };

    const runtime = await this.registry.get(principal.tenantId, job.connectionId);
    const importer = importerFor(runtime, this.config);
    const [written, info] = await Promise.all([
      importer.listMessages(Number(target)).catch(() => null),
      importer.getConversation(Number(target)).catch(() => null),
    ]);
    if (written === null) return { source, imported: null, comparison: null };
    const keys = new Map(conversation.messages.map((m) => [importMessageKey(jobKey, m.id), m]));
    const ours = written.filter((m) => m.key && keys.has(m.key));
    const started = info?.attributes.hv_started_at;
    const imported: NonNullable<MigrationSample['imported']> = {
      sourceId: conversation.record.id,
      startedAt: typeof started === 'string' ? started : null,
      contactName: source.contactName,
      messages: ours.map((m) => {
        const original = Number(m.contentAttributes.external_created_at);
        const meta = (m.contentAttributes.hv_import ?? {}) as {
          author?: { kind?: string; name?: string | null };
        };
        const kind = meta.author?.kind;
        return {
          sourceId: keys.get(m.key as string)?.id ?? null,
          author: {
            kind:
              kind === 'customer' || kind === 'agent' || kind === 'bot' || kind === 'system'
                ? kind
                : m.direction === 'incoming'
                  ? 'customer'
                  : 'agent',
            name: meta.author
              ? (meta.author.name ?? null)
              : m.sender.kind === 'system'
                ? null
                : m.sender.name,
          },
          visibility: m.private ? ('internal' as const) : ('public' as const),
          text: m.text ? redact(m.text) : null,
          createdAt:
            Number.isFinite(original) && original > 0
              ? new Date(original * 1000).toISOString()
              : null,
          importedAt: m.createdAt.toISOString(),
          attachments: m.attachments.map((a) => ({
            name: a.name ?? decodeURIComponent(a.url?.split('/').pop()?.split('?')[0] ?? 'file'),
            status: 'imported' as const,
            reason: null,
          })),
        };
      }),
    };
    const problems: string[] = [];
    const expected = conversation.messages.filter(
      (m) => status('message', m.id)?.status === 'imported',
    );
    if (
      expected.map((m) => m.id).join('\n') !== imported.messages.map((m) => m.sourceId).join('\n')
    ) {
      problems.push('order_or_count');
    }
    const toSecond = (iso: string) =>
      new Date(Math.floor(new Date(iso).getTime() / 1000) * 1000).toISOString();
    for (const message of imported.messages) {
      const original = expected.find((m) => m.id === message.sourceId);
      if (!original) continue;
      if (message.createdAt !== toSecond(original.createdAt)) {
        problems.push(`original_time:${original.id}`);
      }
      if (message.visibility !== original.visibility) problems.push(`visibility:${original.id}`);
    }
    return { source, imported, comparison: { matches: problems.length === 0, problems } };
  }

  /** Queues an export of the brand's conversations as a Hamnivo package (M02). */
  async createExport(principal: StaffPrincipal, brandPublicId: string): Promise<MigrationJob> {
    const brandId = fromPublicId('brand', brandPublicId);
    return this.tx(principal, async (tx) => {
      const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, brandId));
      if (!brand) throw new AppError('NOT_FOUND', { detail: 'Brand not found.' });
      enforce(
        this.allowed(principal, 'conversations.export', {
          workspaceId: brand.workspaceId,
          brandId,
        }),
      );
      const connectionId = await brandConnectionId(tx, brandId);
      if (!connectionId) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'This brand is not connected to Chatwoot.',
        });
      }
      const [job] = await tx
        .insert(schema.migrationJobs)
        .values({
          tenantId: principal.tenantId,
          workspaceId: brand.workspaceId,
          brandId,
          connectionId,
          sourceSystem: 'hamnivo',
          sourceKind: 'api',
          label: `Export · ${brand.name}`,
          state: 'queued',
          options: { kind: 'export' },
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!job) throw new Error('job insert returned nothing');
      await this.queue(tx, job, 'migration.export');
      await this.audit(tx, principal, 'migration.export_requested', job, {
        brandId: brandPublicId,
      });
      return this.view(tx, job);
    });
  }

  async packageFile(
    principal: StaffPrincipal,
    publicId: string,
  ): Promise<{ name: string; bytes: Buffer }> {
    return this.tx(principal, async (tx) => {
      const job = await this.load(tx, principal, publicId, 'conversations.export');
      const [file] = await tx
        .select()
        .from(schema.migrationFiles)
        .where(
          and(
            eq(schema.migrationFiles.jobId, job.id),
            eq(schema.migrationFiles.purpose, 'package'),
          ),
        );
      if (!file?.raw) throw new AppError('NOT_FOUND', { detail: 'The package is not available.' });
      await this.audit(tx, principal, 'migration.package_downloaded', job, {
        bytes: file.byteSize,
      });
      return { name: file.name, bytes: file.raw };
    });
  }
}
