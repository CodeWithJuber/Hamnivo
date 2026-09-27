import { createHash } from 'node:crypto';
import { ChatwootError, ChatwootImporter } from '@hamnivo/chatwoot';
import {
  appendAudit,
  type ClaimedOutboxEvent,
  type Db,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type ContactRecord,
  chatwootDescriptor,
  classifyStatus,
  dryRun,
  type ItemTally,
  importContactIdentifier,
  importConversationKey,
  importMessageKey,
  MAX_ITEM_ATTEMPTS,
  type MessageRecord,
  neutralizeMentions,
  nextStep,
  Pacer,
  PackageError,
  type ParsedConversation,
  type ParsedSource,
  planItems,
  preflight,
  type Reason,
  reconcile,
  type SampleVerification,
  writePackage,
} from '@hamnivo/migration-sdk';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { AuthorityRegistry } from '../authority/registry.js';
import type { AppConfig } from '../config.js';
import { SCANNER } from '../knowledge/ingestion.service.js';
import type { Scanner } from '../knowledge/scanner.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { readChatwootHistory } from './chatwoot-source.js';
import {
  brandConnectionId,
  destinationChecks,
  importerFor,
  importInboxOf,
  readUpload,
  uploadFormat,
} from './destination.js';
import { checkSourceUrl, guardedFetch, SourceUrlError } from './source-guard.js';
import type { Checkpoint, ItemRow, JobRow, JobStats } from './views.js';

/** Outbox attempts while the scanner is unreachable before an upload is refused. */
const SCAN_ATTEMPTS = 10;
/** Outbox attempts of one pass before a Chatwoot outage fails the job (it can be resumed). */
const JOB_ATTEMPTS = 8;
const LEASE_MS = 120_000;
/** Chatwoot's default upload limit. */
const ATTACHMENT_MAX_BYTES = 40 * 1024 * 1024;
const SAMPLE_SIZE = 5;
const ACTOR = 'migration-worker';
/** Largest snapshot of an API source (it is stored like an upload until the job is closed). */
const SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;

/** Where an API source is read from (migration_jobs.source_config); the token is a secret. */
export interface ApiSourceConfig {
  baseUrl: string;
  accountId: number;
  inboxIds?: number[];
}

/** A Chatwoot answer that may change on a later attempt (outage, timeout, rate limit). */
class Transient extends Error {
  override name = 'Transient';
}

function transient(error: unknown): boolean {
  return (
    error instanceof Transient ||
    (error instanceof ChatwootError && classifyStatus(error.status) !== 'permanent')
  );
}

const ALLOWED_TYPES = [
  /^image\/(png|jpeg|gif|webp|bmp|heic|heif)$/,
  /^audio\//,
  /^video\//,
  /^application\/pdf$/,
  /^application\/vnd\.openxmlformats-officedocument\./,
  /^application\/(msword|vnd\.ms-excel|vnd\.ms-powerpoint)$/,
];
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);

interface Context {
  tenantId: string;
  job: JobRow;
  jobKey: string;
  parsed: ParsedSource;
  importer: ChatwootImporter;
  connectionId: string;
  importInboxId: number;
  /** Source IDs are unique only within their origin: mappings are keyed by both. */
  namespace: string;
  pacerSeeded: Set<string>;
  /** When this pass hands over to the next one (epoch ms). */
  deadline: number;
  leaseRenewedAt: number;
  /** Something was written in this pass (each pass makes progress before handing over). */
  progressed: boolean;
}

/**
 * The migration worker (M03, M07, M08), run through the outbox:
 * - `migration.scan`: scan the upload (fail closed), read it, preflight it.
 * - `migration.dry_run`: count what an import would do; nothing is written anywhere.
 * - `migration.run`: import in passes with a checkpoint; each write is recorded as `writing` first
 *   and looked up by its key after a crash, so a re-run never duplicates anything.
 * - `migration.rollback`: remove exactly what the job created.
 */
@Injectable()
export class MigrationEngine {
  private readonly logger = new Logger(MigrationEngine.name);

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(SCANNER) private readonly scanner: Scanner,
    private readonly registry: AuthorityRegistry,
    private readonly secrets: SecretBroker,
  ) {}

  private tx<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(this.db, { tenantId, actorId: ACTOR }, work);
  }

  private audit(tx: TenantTx, job: JobRow, action: string, data: Record<string, unknown> = {}) {
    return appendAudit(tx, {
      actorType: 'system',
      actorId: ACTOR,
      action,
      targetType: 'migration_job',
      targetId: toPublicId('migration', job.id),
      outcome: 'success',
      data,
    });
  }

  private async job(tenantId: string, jobId: string): Promise<JobRow | null> {
    return this.tx(tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.migrationJobs)
        .where(eq(schema.migrationJobs.id, jobId));
      return row ?? null;
    });
  }

  private async update(tenantId: string, jobId: string, change: Partial<JobRow>): Promise<void> {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.migrationJobs)
        .set({ ...change, updatedAt: this.clock() })
        .where(eq(schema.migrationJobs.id, jobId)),
    );
  }

  /** Takes the job for this worker, or returns null when another one holds it. */
  private async acquire(
    tenantId: string,
    jobId: string,
    states: JobRow['state'][],
  ): Promise<JobRow | null> {
    const now = this.clock();
    return this.tx(tenantId, async (tx) => {
      const [row] = await tx
        .update(schema.migrationJobs)
        .set({ leaseUntil: new Date(now.getTime() + LEASE_MS), updatedAt: now })
        .where(
          and(
            eq(schema.migrationJobs.id, jobId),
            inArray(schema.migrationJobs.state, states),
            or(isNull(schema.migrationJobs.leaseUntil), lt(schema.migrationJobs.leaseUntil, now)),
          ),
        )
        .returning();
      return row ?? null;
    });
  }

  private async exportFile(tenantId: string, jobId: string) {
    return this.tx(tenantId, async (tx) => {
      const [file] = await tx
        .select()
        .from(schema.migrationFiles)
        .where(
          and(eq(schema.migrationFiles.jobId, jobId), eq(schema.migrationFiles.purpose, 'export')),
        )
        .limit(1);
      return file ?? null;
    });
  }

  private async openUpload(tenantId: string, job: JobRow) {
    const file = await this.exportFile(tenantId, job.id);
    if (!file?.raw) throw new PackageError('empty', 'The uploaded export is no longer available.');
    return readUpload(file, file.raw, uploadFormat(job));
  }

  /** Source IDs are unique only within their origin (a package's source, an API account). */
  private namespaceOf(job: JobRow, parsed: ParsedSource | null): string {
    if (job.sourceKind === 'api') {
      const config = job.sourceConfig as Partial<ApiSourceConfig>;
      return `${config.baseUrl ?? ''}#${config.accountId ?? ''}`;
    }
    return parsed?.origin ? `${parsed.origin.system}#${parsed.origin.account ?? ''}` : '';
  }

  private mapKey(namespace: string, sourceId: string): string {
    return namespace ? `${namespace}|${sourceId}` : sourceId;
  }

  // ------------------------------------------------------------------ scan and preflight

  async onScan(event: ClaimedOutboxEvent): Promise<void> {
    const { jobId } = event.payload as { jobId: string };
    const tenantId = event.tenantId;
    let job = await this.job(tenantId, jobId);
    if (job?.state !== 'scanning') return;
    if (job.sourceKind === 'api' && !(await this.exportFile(tenantId, jobId))) {
      // An API source is read once into a package, which is then checked like an upload.
      if (!(await this.snapshotSource(tenantId, job, event.attempts))) return;
      job = (await this.job(tenantId, jobId)) ?? job;
    }
    const file = await this.exportFile(tenantId, jobId);
    if (!file?.raw) return;

    const verdict = await this.scanner.scan(file.raw);
    if (!verdict.clean) {
      // ClamAV needs a few minutes after a restart: keep the upload and retry before refusing.
      if (verdict.reason === 'scan_unavailable' && event.attempts < SCAN_ATTEMPTS) {
        throw new Error('The malware scanner is not reachable yet');
      }
      await this.reject(tenantId, job, file.id, verdict.reason, verdict.engine);
      return;
    }
    let opened: ReturnType<typeof readUpload>;
    try {
      opened = readUpload(file, file.raw, uploadFormat(job));
    } catch (error) {
      if (!(error instanceof PackageError)) throw error;
      await this.reject(tenantId, job, file.id, error.code, verdict.engine, error.message);
      return;
    }
    const report = await this.preflightReport(tenantId, job, opened);
    await this.tx(tenantId, async (tx) => {
      await tx
        .update(schema.migrationFiles)
        .set({ state: 'clean', scannedAt: this.clock(), scanEngine: verdict.engine })
        .where(eq(schema.migrationFiles.id, file.id));
      await tx
        .update(schema.migrationJobs)
        .set({
          state: report.blocking ? 'blocked' : 'ready',
          preflight: report,
          updatedAt: this.clock(),
        })
        .where(
          and(eq(schema.migrationJobs.id, job.id), eq(schema.migrationJobs.state, 'scanning')),
        );
      await this.audit(tx, job, 'migration.checked', {
        blocking: report.blocking,
        conversations: report.counts.conversations,
        messages: report.counts.messages,
      });
    });
  }

  private async reject(
    tenantId: string,
    job: JobRow,
    fileId: string,
    code: string,
    engine: string,
    detail?: string,
  ) {
    await this.tx(tenantId, async (tx) => {
      await tx
        .update(schema.migrationFiles)
        .set({
          state: 'rejected',
          raw: null,
          rejectedReason: code,
          scanEngine: engine,
          scannedAt: this.clock(),
        })
        .where(eq(schema.migrationFiles.id, fileId));
      await tx
        .update(schema.migrationJobs)
        .set({
          state: 'rejected',
          errorCode: code,
          errorDetail: detail ?? null,
          finishedAt: this.clock(),
          updatedAt: this.clock(),
        })
        .where(eq(schema.migrationJobs.id, job.id));
      await this.audit(tx, job, 'migration.rejected', { reason: code });
    });
  }

  /**
   * Reads another Chatwoot account (M04) with the token staff gave, oldest conversations first,
   * skipping those an earlier import of the same account already brought in, and stores what it
   * read as a package. The token is used for this only: it is revoked in Hamnivo afterwards.
   * Returns false when the job was refused (it then says why).
   */
  private async snapshotSource(tenantId: string, job: JobRow, attempts: number): Promise<boolean> {
    const config = job.sourceConfig as ApiSourceConfig;
    const leased = await this.acquire(tenantId, job.id, ['scanning']);
    // Another worker is reading this source: try again once its lease has passed.
    if (!leased) throw new Transient('The source is being read by another worker');
    const allowPrivate = this.config.MIGRATION_SOURCE_ALLOW_PRIVATE;
    try {
      const token = job.sourceSecretId
        ? await this.tx(tenantId, (tx) =>
            this.secrets.reveal(tx, tenantId, job.sourceSecretId as string).catch(() => null),
          )
        : null;
      if (!token) {
        await this.refuse(tenantId, job, 'source_denied');
        return false;
      }
      try {
        await checkSourceUrl(config.baseUrl, allowPrivate);
      } catch (error) {
        if (!(error instanceof SourceUrlError)) throw error;
        await this.refuse(tenantId, job, error.code);
        return false;
      }
      const source = new ChatwootImporter({
        baseUrl: config.baseUrl,
        accountId: config.accountId,
        token,
        timeoutMs: this.config.CHATWOOT_TIMEOUT_MS,
        fetch: guardedFetch(allowPrivate),
      });
      const namespace = this.namespaceOf(job, null);
      const known = await this.tx(tenantId, async (tx) => {
        const connectionId = await brandConnectionId(tx, job.brandId);
        if (!connectionId) return new Set<number>();
        const rows = await tx
          .select({ sourceId: schema.externalIdMappings.sourceId })
          .from(schema.externalIdMappings)
          .where(
            and(
              eq(schema.externalIdMappings.connectionId, connectionId),
              eq(schema.externalIdMappings.sourceSystem, job.sourceSystem),
              eq(schema.externalIdMappings.kind, 'conversation'),
              sql`starts_with(${schema.externalIdMappings.sourceId}, ${`${namespace}|conversation:`})`,
            ),
          );
        return new Set(rows.map((r) => Number(r.sourceId.split('|conversation:')[1])));
      });
      let renewedAt = this.clock().getTime();
      let role: string | null;
      let history: Awaited<ReturnType<typeof readChatwootHistory>>;
      try {
        role = (await source.access()).role;
        if (!role) {
          await this.refuse(tenantId, job, 'source_denied');
          return false;
        }
        history = await readChatwootHistory(source, {
          inboxIds: config.inboxIds ?? [],
          system: 'chatwoot',
          maxConversations: this.config.MIGRATION_SOURCE_MAX_CONVERSATIONS,
          maxAttachmentBytes: ATTACHMENT_MAX_BYTES,
          oldestFirst: true,
          skip: (id) => known.has(id),
          onConversation: async () => {
            const now = this.clock().getTime();
            if (now - renewedAt < LEASE_MS / 3) return;
            renewedAt = now;
            await this.update(tenantId, job.id, { leaseUntil: new Date(now + LEASE_MS) });
          },
        });
      } catch (error) {
        if (!(error instanceof ChatwootError)) throw error;
        if (error.status === 401 || error.status === 403 || error.status === 404) {
          await this.refuse(tenantId, job, 'source_denied', `HTTP ${error.status}`);
          return false;
        }
        if (classifyStatus(error.status) !== 'permanent' && attempts < SCAN_ATTEMPTS) throw error;
        await this.refuse(tenantId, job, 'source_unreachable', `HTTP ${error.status}`);
        return false;
      }
      const now = this.clock();
      const missing = history.attachments.filter((a) => !a.bytes).length;
      const bytes = writePackage({
        source: {
          system: 'chatwoot',
          account: `${new URL(config.baseUrl).host}#${config.accountId}`,
          exportedAt: now.toISOString(),
        },
        generator: { name: 'Hamnivo', version: '1' },
        contacts: history.contacts,
        conversations: history.conversations,
        messages: history.messages,
        attachments: history.attachments,
        createdAt: now,
        complete: !history.truncated && missing === 0,
        notes: [
          ...(history.truncated
            ? [`Read ${history.conversations.length} conversations; the account has more.`]
            : []),
          ...(missing > 0 ? [`${missing} files could not be downloaded.`] : []),
        ],
      });
      if (bytes.byteLength > SNAPSHOT_MAX_BYTES) {
        await this.refuse(tenantId, job, 'too_large');
        return false;
      }
      await this.tx(tenantId, async (tx) => {
        await tx.insert(schema.migrationFiles).values({
          tenantId,
          jobId: job.id,
          purpose: 'export',
          name: `chatwoot-${new URL(config.baseUrl).hostname}-${config.accountId}.zip`,
          mediaType: 'application/zip',
          byteSize: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest(),
          raw: Buffer.from(bytes),
          createdBy: job.createdBy,
        });
        await tx
          .update(schema.migrationJobs)
          .set({
            stats: {
              ...(job.stats as JobStats),
              sourceRole: role,
              sourceSkipped: history.skipped,
              sourceTruncated: history.truncated,
            },
            updatedAt: now,
          })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.revokeSource(tx, job);
        await this.audit(tx, job, 'migration.source_read', {
          conversations: history.conversations.length,
          messages: history.messages.length,
          skipped: history.skipped,
          truncated: history.truncated,
          role,
        });
      });
      return true;
    } finally {
      await this.update(tenantId, job.id, { leaseUntil: null });
    }
  }

  /** The source token is needed once: after reading (or refusing) it is revoked in Hamnivo. */
  private async revokeSource(tx: TenantTx, job: JobRow) {
    if (!job.sourceSecretId) return;
    await tx
      .update(schema.secrets)
      .set({ revokedAt: this.clock() })
      .where(and(eq(schema.secrets.id, job.sourceSecretId), isNull(schema.secrets.revokedAt)));
  }

  /** Refuses an API source before anything was read (bad address, token, or no access). */
  private async refuse(tenantId: string, job: JobRow, code: string, detail?: string) {
    await this.tx(tenantId, async (tx) => {
      await tx
        .update(schema.migrationJobs)
        .set({
          state: 'rejected',
          errorCode: code,
          errorDetail: detail ?? null,
          finishedAt: this.clock(),
          updatedAt: this.clock(),
        })
        .where(eq(schema.migrationJobs.id, job.id));
      await this.revokeSource(tx, job);
      await this.audit(tx, job, 'migration.rejected', { reason: code });
    });
  }

  /** The export's preflight (M01) with the destination checks, without message content. */
  async preflightReport(tenantId: string, job: JobRow, opened: ReturnType<typeof readUpload>) {
    const api = job.sourceKind === 'api';
    const descriptor = api
      ? {
          ...opened.adapter.descriptor,
          system: 'chatwoot' as const,
          limits: chatwootDescriptor.limits,
        }
      : opened.adapter.descriptor;
    const source = preflight(opened.parsed, descriptor);
    if (api) source.source.system = 'chatwoot';
    const destination = await this.tx(tenantId, async (tx) => {
      const connectionId = await brandConnectionId(tx, job.brandId);
      return {
        connectionId,
        importInbox: connectionId ? await importInboxOf(tx, connectionId, job.brandId) : null,
      };
    });
    let checks: Array<{ code: string; status: 'ok' | 'warning' | 'blocked'; detail?: string }>;
    if (!destination.connectionId) {
      checks = [{ code: 'authority_connected', status: 'blocked' }];
    } else {
      const runtime = await this.registry.get(tenantId, destination.connectionId);
      checks = await destinationChecks(importerFor(runtime, this.config), destination.importInbox);
    }
    if (opened.detected)
      checks.push({ code: 'source_mismatch', status: 'blocked', detail: opened.detected });
    if (api) {
      // A token of an agent reads only that agent's inboxes.
      const role = (job.stats as JobStats).sourceRole ?? null;
      checks.push({
        code: 'source_access',
        status: role === 'administrator' ? 'ok' : 'warning',
        ...(role ? { detail: role } : {}),
      });
    }
    return {
      ...source,
      detected: opened.detected,
      checks,
      blocking:
        source.blocking || opened.detected !== null || checks.some((c) => c.status === 'blocked'),
      checkedAt: this.clock().toISOString(),
    };
  }

  // ------------------------------------------------------------------ dry run

  async onDryRun(event: ClaimedOutboxEvent): Promise<void> {
    const { jobId } = event.payload as { jobId: string };
    const tenantId = event.tenantId;
    const job = await this.job(tenantId, jobId);
    if (job?.state !== 'dry_running') return;
    const { parsed } = await this.openUpload(tenantId, job);
    const existing = await this.tx(tenantId, async (tx) => {
      const connectionId = await brandConnectionId(tx, job.brandId);
      return connectionId
        ? this.existingConversations(tx, connectionId, job, parsed)
        : new Set<string>();
    });
    // Counts only: nothing is written to Chatwoot, to mappings or to items.
    const result = dryRun(parsed, { conversations: existing });
    await this.tx(tenantId, async (tx) => {
      await tx
        .update(schema.migrationJobs)
        .set({
          state: 'dry_run_ready',
          dryRun: { ...result, checkedAt: this.clock().toISOString() },
          updatedAt: this.clock(),
        })
        .where(eq(schema.migrationJobs.id, job.id));
      await this.audit(tx, job, 'migration.dry_run_done', {
        ready: result.conversations.ready,
        duplicates: result.conversations.duplicates,
        needsReview: result.conversations.needsReview,
      });
    });
  }

  /** Conversations of this export already imported into the brand's Chatwoot by another job. */
  private async existingConversations(
    tx: TenantTx,
    connectionId: string,
    job: JobRow,
    parsed: ParsedSource,
  ): Promise<Set<string>> {
    const namespace = this.namespaceOf(job, parsed);
    const byKey = new Map(
      parsed.conversations.map((c) => [this.mapKey(namespace, c.record.id), c.record.id]),
    );
    const ids = [...byKey.keys()];
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += 1000) {
      const rows = await tx
        .select({
          sourceId: schema.externalIdMappings.sourceId,
          jobId: schema.externalIdMappings.jobId,
        })
        .from(schema.externalIdMappings)
        .where(
          and(
            eq(schema.externalIdMappings.connectionId, connectionId),
            eq(schema.externalIdMappings.sourceSystem, job.sourceSystem),
            eq(schema.externalIdMappings.kind, 'conversation'),
            inArray(schema.externalIdMappings.sourceId, ids.slice(i, i + 1000)),
          ),
        );
      for (const row of rows) {
        const id = byKey.get(row.sourceId);
        if (row.jobId !== job.id && id !== undefined) found.add(id);
      }
    }
    return found;
  }

  // ------------------------------------------------------------------ import

  async onRun(event: ClaimedOutboxEvent): Promise<void> {
    const { jobId } = event.payload as { jobId: string };
    const tenantId = event.tenantId;
    const job = await this.acquire(tenantId, jobId, ['queued', 'running']);
    if (!job) return;
    try {
      await this.runSlice(tenantId, job);
    } catch (error) {
      await this.update(tenantId, jobId, { leaseUntil: null });
      if (transient(error) && event.attempts < JOB_ATTEMPTS) throw error;
      await this.fail(tenantId, jobId, error);
    }
  }

  private async fail(tenantId: string, jobId: string, error: unknown) {
    const code =
      error instanceof ChatwootError
        ? 'authority_unavailable'
        : error instanceof PackageError
          ? error.code
          : 'internal';
    this.logger.warn(`migration ${jobId} failed: ${code}`);
    await this.tx(tenantId, async (tx) => {
      const [job] = await tx
        .update(schema.migrationJobs)
        .set({
          state: 'failed',
          errorCode: code,
          errorDetail: error instanceof ChatwootError ? `HTTP ${error.status}` : null,
          leaseUntil: null,
          updatedAt: this.clock(),
        })
        .where(eq(schema.migrationJobs.id, jobId))
        .returning();
      if (job) await this.audit(tx, job, 'migration.failed', { reason: code });
    });
  }

  private async runSlice(tenantId: string, leased: JobRow): Promise<void> {
    const started = this.clock().getTime();
    let job = leased;
    if (job.requestedAction) return this.applyRequest(tenantId, job);
    if (job.state === 'queued') {
      await this.update(tenantId, job.id, {
        state: 'running',
        startedAt: job.startedAt ?? this.clock(),
      });
      job = { ...job, state: 'running' };
    }
    const connectionId = job.connectionId;
    if (!connectionId) throw new Error('migration job without a connection');
    const runtime = await this.registry.get(tenantId, connectionId);
    const importer = importerFor(runtime, this.config);
    const importInboxId = await this.ensureImportInbox(tenantId, job, importer);
    const { parsed } = await this.openUpload(tenantId, job);
    const checkpoint = job.checkpoint as Checkpoint;
    if (!checkpoint.inboxVerified) {
      // Never write into an inbox that could answer or notify anyone.
      const settings = await importer.inspectInbox(importInboxId);
      const quiet =
        !settings.webhookUrl &&
        !settings.agentBot &&
        !settings.autoAssignment &&
        !settings.greeting &&
        !settings.csat &&
        !settings.lockToSingleConversation;
      if (!quiet) {
        await this.update(tenantId, job.id, {
          state: 'failed',
          errorCode: 'import_inbox_not_quiet',
          leaseUntil: null,
        });
        return;
      }
      checkpoint.inboxVerified = true;
    }
    if (!checkpoint.planned) {
      await this.plan(tenantId, job, parsed, connectionId);
      checkpoint.planned = true;
    }
    checkpoint.total = parsed.conversations.length;
    await this.saveCheckpoint(tenantId, job.id, checkpoint);

    const context: Context = {
      tenantId,
      job,
      jobKey: toPublicId('migration', job.id),
      parsed,
      importer,
      connectionId,
      importInboxId,
      namespace: this.namespaceOf(job, parsed),
      pacerSeeded: new Set(),
      deadline: started + this.config.MIGRATION_SLICE_SECONDS * 1000,
      leaseRenewedAt: this.clock().getTime(),
      progressed: false,
    };
    let index = checkpoint.index ?? 0;
    let done = 0;
    while (index < parsed.conversations.length) {
      if (
        done >= this.config.MIGRATION_SLICE_CONVERSATIONS ||
        (context.progressed && this.clock().getTime() >= context.deadline)
      ) {
        break;
      }
      const fresh = await this.job(tenantId, job.id);
      if (fresh?.requestedAction) return this.applyRequest(tenantId, fresh);
      const outcome = await this.importConversation(
        context,
        parsed.conversations[index] as ParsedConversation,
      );
      // A long conversation continues in the next pass, from its first message not yet written.
      if (outcome === 'partial') break;
      index += 1;
      done += 1;
      checkpoint.index = index;
      checkpoint.at = this.clock().toISOString();
      await this.saveCheckpoint(tenantId, job.id, checkpoint);
    }
    if (index < parsed.conversations.length) {
      // Hand over to the next pass (the outbox relays it), so no single pass runs for long.
      await this.tx(tenantId, async (tx) => {
        await tx
          .update(schema.migrationJobs)
          .set({ leaseUntil: null, updatedAt: this.clock() })
          .where(eq(schema.migrationJobs.id, job.id));
        await enqueueOutbox(tx, tenantId, {
          topic: 'migration.run',
          aggregateType: 'migration_job',
          aggregateId: job.id,
          payload: { jobId: job.id },
        });
      });
      return;
    }
    await this.finish(context, 'completed');
  }

  private async saveCheckpoint(tenantId: string, jobId: string, checkpoint: Checkpoint) {
    await this.update(tenantId, jobId, {
      checkpoint,
      leaseUntil: new Date(this.clock().getTime() + LEASE_MS),
    });
  }

  /** Applies a pause or cancel requested by staff at this checkpoint. */
  private async applyRequest(tenantId: string, job: JobRow): Promise<void> {
    if (job.requestedAction === 'pause') {
      await this.tx(tenantId, async (tx) => {
        await tx
          .update(schema.migrationJobs)
          .set({
            state: 'paused',
            requestedAction: null,
            leaseUntil: null,
            updatedAt: this.clock(),
          })
          .where(eq(schema.migrationJobs.id, job.id));
        await this.audit(tx, job, 'migration.paused_at_checkpoint', job.checkpoint as never);
      });
      return;
    }
    const connectionId = job.connectionId;
    const runtime = connectionId ? await this.registry.get(tenantId, connectionId) : null;
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.migrationItems)
        .set({ reason: 'cancelled' })
        .where(
          and(eq(schema.migrationItems.jobId, job.id), eq(schema.migrationItems.status, 'pending')),
        ),
    );
    const { parsed } = await this.openUpload(tenantId, job);
    await this.finish(
      {
        tenantId,
        job,
        jobKey: toPublicId('migration', job.id),
        parsed,
        importer: runtime ? importerFor(runtime, this.config) : (null as never),
        connectionId: connectionId ?? '',
        importInboxId: 0,
        namespace: this.namespaceOf(job, parsed),
        pacerSeeded: new Set(),
        deadline: 0,
        leaseRenewedAt: 0,
        progressed: false,
      },
      'cancelled',
    );
  }

  private async ensureImportInbox(
    tenantId: string,
    job: JobRow,
    importer: ChatwootImporter,
  ): Promise<number> {
    const connectionId = job.connectionId as string;
    const existing = await this.tx(tenantId, (tx) => importInboxOf(tx, connectionId, job.brandId));
    if (existing) {
      if (job.importInboxId !== existing.id) {
        await this.update(tenantId, job.id, { importInboxId: existing.id });
      }
      return existing.externalInboxId;
    }
    const brand = await this.tx(tenantId, async (tx) => {
      const [row] = await tx.select().from(schema.brands).where(eq(schema.brands.id, job.brandId));
      return row;
    });
    const { inboxId } = await importer.createImportInbox(
      `${brand?.name ?? 'Brand'} · imported history`,
    );
    await this.tx(tenantId, async (tx) => {
      const [inbox] = await tx
        .insert(schema.authorityInboxes)
        .values({
          tenantId,
          connectionId,
          brandId: job.brandId,
          purpose: 'import',
          externalInboxId: inboxId,
          channelType: 'Channel::Api',
        })
        .returning();
      if (inbox) {
        await tx
          .update(schema.migrationJobs)
          .set({ importInboxId: inbox.id })
          .where(eq(schema.migrationJobs.id, job.id));
      }
      await this.audit(tx, job, 'migration.import_inbox_created', { externalInboxId: inboxId });
    });
    // Webhook intake learns about the new inbox (it ignores events from import inboxes).
    this.registry.invalidate(tenantId, connectionId);
    return inboxId;
  }

  /** One item per object of the export; duplicates of earlier imports are skipped. */
  private async plan(tenantId: string, job: JobRow, parsed: ParsedSource, connectionId: string) {
    const existing = await this.tx(tenantId, (tx) =>
      this.existingConversations(tx, connectionId, job, parsed),
    );
    const items = planItems(parsed, { conversations: existing });
    for (let i = 0; i < items.length; i += 500) {
      await this.tx(tenantId, (tx) =>
        tx
          .insert(schema.migrationItems)
          .values(
            items.slice(i, i + 500).map((item) => ({
              tenantId,
              jobId: job.id,
              kind: item.kind,
              sourceId: item.sourceId,
              conversationSourceId: item.conversationSourceId,
              seq: item.seq,
              status: item.status,
              reason: item.reason,
              private: item.private,
            })),
          )
          .onConflictDoNothing(),
      );
    }
    const stats: JobStats = {
      found: {
        contacts: parsed.contacts.length,
        conversations: parsed.conversations.length,
        messages: parsed.conversations.reduce((sum, c) => sum + c.messages.length, 0),
        attachments: parsed.attachments.size,
      },
      declared: parsed.declared ?? {},
      truncated: parsed.truncated,
      unidentified: dryRun(parsed).unidentified,
      unsupportedFields: parsed.fields
        .filter((f) => f.status === 'unsupported')
        .map((f) => ({ path: f.path, count: f.count })),
      notesNotPrivate: 0,
      otherMessageTypes: 0,
      quietInbox: true,
    };
    await this.update(tenantId, job.id, { stats });
  }

  private async items(tenantId: string, jobId: string, conversationSourceId: string) {
    return this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, jobId),
            eq(schema.migrationItems.conversationSourceId, conversationSourceId),
          ),
        )
        .orderBy(asc(schema.migrationItems.seq)),
    );
  }

  private async setItem(tenantId: string, itemId: string, change: Partial<ItemRow>) {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.migrationItems)
        .set({ ...change, updatedAt: this.clock() })
        .where(eq(schema.migrationItems.id, itemId)),
    );
  }

  private async setItems(
    tenantId: string,
    jobId: string,
    conversationSourceId: string,
    from: ItemRow['status'][],
    change: Partial<ItemRow>,
  ) {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.migrationItems)
        .set({ ...change, updatedAt: this.clock() })
        .where(
          and(
            eq(schema.migrationItems.jobId, jobId),
            eq(schema.migrationItems.conversationSourceId, conversationSourceId),
            inArray(schema.migrationItems.status, from),
          ),
        ),
    );
  }

  private failure(error: unknown): { reason: Reason; detail: string } | null {
    if (!(error instanceof ChatwootError)) return null;
    return classifyStatus(error.status) === 'permanent'
      ? { reason: 'authority_rejected', detail: `HTTP ${error.status}` }
      : null;
  }

  private async importConversation(
    ctx: Context,
    conversation: ParsedConversation,
  ): Promise<'done' | 'partial'> {
    const { tenantId, job } = ctx;
    const sourceId = conversation.record.id;
    const rows = await this.items(tenantId, job.id, sourceId);
    const item = rows.find((r) => r.kind === 'conversation');
    if (!item || !['pending', 'writing'].includes(item.status)) return 'done';

    const contactId = await this.ensureContact(ctx, conversation.record.contactId);
    if (contactId === null) {
      await this.setItems(tenantId, job.id, sourceId, ['pending', 'writing'], {
        status: 'failed',
        reason: 'parent_failed',
      });
      return 'done';
    }
    const conversationId = await this.ensureConversation(ctx, conversation, item, contactId);
    if (conversationId === null) return 'done';

    const messages = new Map(conversation.messages.map((m) => [m.id, m]));
    for (const row of rows) {
      if (row.kind !== 'message' || !['pending', 'writing'].includes(row.status)) continue;
      const message = messages.get(row.sourceId);
      if (!message) continue;
      if (ctx.progressed && this.clock().getTime() >= ctx.deadline) return 'partial';
      await this.importMessage(ctx, conversationId, message, row, rows);
      ctx.progressed = true;
      await this.renewLease(ctx);
    }
    // Resolved last: only once every message is written, so no customer message reopens it.
    if (conversation.record.status === 'resolved') {
      try {
        await ctx.importer.resolve(conversationId);
      } catch (error) {
        if (transient(error)) throw error;
      }
    }
    await this.setItem(tenantId, item.id, { status: 'imported', importedAt: this.clock() });
    return 'done';
  }

  /** Keeps this worker's claim on the job while a long conversation is written. */
  private async renewLease(ctx: Context) {
    const now = this.clock().getTime();
    if (now - ctx.leaseRenewedAt < LEASE_MS / 3) return;
    ctx.leaseRenewedAt = now;
    await this.update(ctx.tenantId, ctx.job.id, { leaseUntil: new Date(now + LEASE_MS) });
  }

  /** The Chatwoot contact for a source contact: reused, looked up after a timeout, or created. */
  private async ensureContact(ctx: Context, contactSourceId: string): Promise<number | null> {
    const { tenantId, job } = ctx;
    const [item] = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, job.id),
            eq(schema.migrationItems.kind, 'contact'),
            eq(schema.migrationItems.sourceId, contactSourceId),
          ),
        ),
    );
    if (!item) return null;
    if (item.status === 'imported' && item.targetRef) return Number(item.targetRef);
    if (!['pending', 'writing'].includes(item.status)) return null;
    const contact = ctx.parsed.contacts.find((c) => c.id === contactSourceId);
    if (!contact) return null;
    // A verified person is the same person whichever export they come from.
    const key = contact.verified
      ? `verified:${contact.verified.issuer ?? ''}:${contact.verified.subject}`
      : this.mapKey(ctx.namespace, contactSourceId);

    // The same person imported by an earlier job (by source ID or verified identity) is reused.
    const [mapping] = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.externalIdMappings)
        .where(
          and(
            eq(schema.externalIdMappings.connectionId, ctx.connectionId),
            eq(schema.externalIdMappings.sourceSystem, job.sourceSystem),
            eq(schema.externalIdMappings.kind, 'contact'),
            eq(schema.externalIdMappings.sourceId, key),
          ),
        ),
    );
    if (mapping && mapping.jobId !== job.id) {
      const existing = await ctx.importer.getContact(Number(mapping.targetRef));
      if (existing) {
        await this.setItem(tenantId, item.id, {
          status: 'imported',
          targetRef: mapping.targetRef,
          created: false,
          importedAt: this.clock(),
        });
        return Number(mapping.targetRef);
      }
    }

    const identifier = importContactIdentifier(ctx.jobKey, key);
    const step = nextStep(item);
    if (step === 'give_up') {
      await this.setItem(tenantId, item.id, { status: 'failed', reason: 'authority_unavailable' });
      return null;
    }
    let contactId: number | null = null;
    if (step === 'resolve') contactId = await ctx.importer.findContactByIdentifier(identifier);
    if (contactId === null) {
      await this.setItem(tenantId, item.id, { status: 'writing', attempts: item.attempts + 1 });
      try {
        contactId = (
          await ctx.importer.createContact({
            inboxId: ctx.importInboxId,
            identifier,
            name: contact.name,
            attributes: contactAttributes(ctx, contact),
          })
        ).contactId;
      } catch (error) {
        // Another source contact with the same verified identity was created first: reuse it.
        if (error instanceof ChatwootError && error.status === 422) {
          contactId = await ctx.importer.findContactByIdentifier(identifier);
        }
        if (contactId === null) {
          const failed = this.failure(error);
          if (!failed) throw error;
          await this.setItem(tenantId, item.id, { status: 'failed', ...failed });
          return null;
        }
      }
    }
    await this.setItem(tenantId, item.id, {
      status: 'imported',
      targetRef: String(contactId),
      created: true,
      importedAt: this.clock(),
    });
    await this.tx(tenantId, (tx) =>
      tx
        .insert(schema.externalIdMappings)
        .values({
          tenantId,
          connectionId: ctx.connectionId,
          brandId: job.brandId,
          sourceSystem: job.sourceSystem,
          kind: 'contact',
          sourceId: key,
          targetRef: String(contactId),
          jobId: job.id,
        })
        .onConflictDoNothing(),
    );
    return contactId;
  }

  /**
   * The Chatwoot conversation: the mapping is reserved first, so no other job can import the same
   * source conversation; a create whose outcome was lost is found again by its key attribute.
   */
  private async ensureConversation(
    ctx: Context,
    conversation: ParsedConversation,
    item: ItemRow,
    contactId: number,
  ): Promise<number | null> {
    const { tenantId, job } = ctx;
    const sourceId = conversation.record.id;
    const mapped = this.mapKey(ctx.namespace, sourceId);
    if (item.targetRef) return Number(item.targetRef);
    const reserved = await this.tx(tenantId, async (tx) => {
      await tx
        .insert(schema.externalIdMappings)
        .values({
          tenantId,
          connectionId: ctx.connectionId,
          brandId: job.brandId,
          sourceSystem: job.sourceSystem,
          kind: 'conversation',
          sourceId: mapped,
          targetRef: 'pending',
          jobId: job.id,
        })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(schema.externalIdMappings)
        .where(
          and(
            eq(schema.externalIdMappings.connectionId, ctx.connectionId),
            eq(schema.externalIdMappings.sourceSystem, job.sourceSystem),
            eq(schema.externalIdMappings.kind, 'conversation'),
            eq(schema.externalIdMappings.sourceId, mapped),
          ),
        );
      return row;
    });
    if (reserved && reserved.jobId !== job.id) {
      await this.setItems(tenantId, job.id, sourceId, ['pending', 'writing'], {
        status: 'skipped',
        reason: 'duplicate_existing',
      });
      return null;
    }
    const key = importConversationKey(ctx.jobKey, sourceId);
    const step = nextStep(item);
    if (step === 'give_up') {
      await this.setItems(tenantId, job.id, sourceId, ['pending', 'writing'], {
        status: 'failed',
        reason: 'authority_unavailable',
      });
      return null;
    }
    let conversationId: number | null = null;
    if (step === 'resolve') conversationId = await ctx.importer.findConversation(contactId, key);
    if (conversationId === null) {
      await this.setItem(tenantId, item.id, { status: 'writing', attempts: item.attempts + 1 });
      try {
        conversationId = (
          await ctx.importer.createConversation({
            inboxId: ctx.importInboxId,
            contactId,
            key,
            attributes: conversationAttributes(ctx, conversation),
          })
        ).conversationId;
      } catch (error) {
        const failed = this.failure(error);
        if (!failed) throw error;
        await this.setItem(tenantId, item.id, { status: 'failed', ...failed });
        await this.setItems(tenantId, job.id, sourceId, ['pending', 'writing'], {
          status: 'failed',
          reason: 'parent_failed',
        });
        await this.tx(tenantId, (tx) =>
          tx
            .delete(schema.externalIdMappings)
            .where(
              and(
                eq(schema.externalIdMappings.jobId, job.id),
                eq(schema.externalIdMappings.kind, 'conversation'),
                eq(schema.externalIdMappings.sourceId, mapped),
              ),
            ),
        );
        return null;
      }
    }
    await this.setItem(tenantId, item.id, {
      status: 'writing',
      targetRef: String(conversationId),
      created: true,
    });
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.externalIdMappings)
        .set({ targetRef: String(conversationId) })
        .where(
          and(
            eq(schema.externalIdMappings.jobId, job.id),
            eq(schema.externalIdMappings.kind, 'conversation'),
            eq(schema.externalIdMappings.sourceId, mapped),
          ),
        ),
    );
    return conversationId;
  }

  private async pacer(ctx: Context, conversationSourceId: string): Promise<Pacer> {
    const pacer = new Pacer(this.config.MIGRATION_MESSAGES_PER_MINUTE, () =>
      this.clock().getTime(),
    );
    // Writes made in the last minute, maybe by an earlier pass, still count.
    const since = new Date(this.clock().getTime() - 60_000);
    const recent = await this.tx(ctx.tenantId, (tx) =>
      tx
        .select({ at: schema.migrationItems.importedAt })
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, ctx.job.id),
            eq(schema.migrationItems.conversationSourceId, conversationSourceId),
            eq(schema.migrationItems.kind, 'message'),
            gt(schema.migrationItems.importedAt, since),
          ),
        ),
    );
    pacer.seed(recent.map((r) => (r.at as Date).getTime()));
    return pacer;
  }

  private pacers = new Map<string, Pacer>();

  private async importMessage(
    ctx: Context,
    conversationId: number,
    message: MessageRecord,
    item: ItemRow,
    rows: ItemRow[],
  ) {
    const { tenantId, job } = ctx;
    const key = importMessageKey(ctx.jobKey, message.id);
    const step = nextStep(item);
    if (step === 'give_up') {
      await this.setItem(tenantId, item.id, { status: 'failed', reason: 'authority_unavailable' });
      return;
    }
    if (step === 'resolve') {
      const found = await ctx.importer.findMessage(conversationId, key);
      if (found) {
        await this.markMessage(ctx, item, rows, message, found.ref, found.private);
        return;
      }
    }
    const files: Array<{ row: ItemRow; name: string; mediaType: string; bytes: Uint8Array }> = [];
    for (const attachmentId of message.attachmentIds) {
      const row = rows.find((r) => r.kind === 'attachment' && r.sourceId === attachmentId);
      if (row?.status !== 'pending') continue;
      const attachment = ctx.parsed.attachments.get(attachmentId);
      const checked = attachment?.bytes
        ? await this.checkFile(attachment.entry, attachment.bytes)
        : ({ problem: 'missing_attachment' } as const);
      if ('problem' in checked && checked.problem === 'scan_unavailable') {
        if (row.attempts + 1 < MAX_ITEM_ATTEMPTS) {
          await this.setItem(tenantId, row.id, { attempts: row.attempts + 1 });
          throw new Transient('The malware scanner is not reachable');
        }
      }
      if ('problem' in checked || !attachment?.bytes) {
        await this.setItem(tenantId, row.id, {
          status: 'quarantined',
          reason: 'problem' in checked ? checked.problem : 'missing_attachment',
        });
        continue;
      }
      files.push({
        row,
        name: attachment.entry.name,
        mediaType: checked.mediaType,
        bytes: attachment.bytes,
      });
    }
    const text = message.text ? neutralizeMentions(message.text) : null;
    if (!text?.trim() && files.length === 0) {
      // Every file of this message was quarantined and there is no text to write.
      await this.setItem(tenantId, item.id, { status: 'quarantined', reason: 'empty_message' });
      return;
    }
    let pacer = this.pacers.get(`${job.id}:${message.conversationId}`);
    if (!pacer || !ctx.pacerSeeded.has(message.conversationId)) {
      pacer = await this.pacer(ctx, message.conversationId);
      this.pacers.set(`${job.id}:${message.conversationId}`, pacer);
      ctx.pacerSeeded.add(message.conversationId);
      while (this.pacers.size > 100) this.pacers.delete(this.pacers.keys().next().value as string);
    }
    await pacer.take();
    await this.setItem(tenantId, item.id, { status: 'writing', attempts: item.attempts + 1 });
    const internal = message.visibility === 'internal';
    try {
      const written = await ctx.importer.postMessage({
        conversationId,
        key,
        direction: message.author.kind === 'customer' ? 'incoming' : 'outgoing',
        private: internal,
        text,
        createdAt: new Date(message.createdAt),
        contentAttributes: {
          hv_import: {
            job: ctx.jobKey,
            source: job.sourceSystem,
            author: { kind: message.author.kind, name: message.author.name ?? null },
          },
        },
        files: files.map((f) => ({ name: f.name, mediaType: f.mediaType, bytes: f.bytes })),
      });
      await this.markMessage(
        ctx,
        item,
        rows,
        message,
        written.ref,
        written.private,
        files.map((f) => f.row),
      );
    } catch (error) {
      const failed = this.failure(error);
      if (!failed) throw error;
      await this.setItem(tenantId, item.id, { status: 'failed', ...failed });
      for (const file of files) {
        await this.setItem(tenantId, file.row.id, { status: 'failed', reason: 'parent_failed' });
      }
    }
  }

  private async markMessage(
    ctx: Context,
    item: ItemRow,
    rows: ItemRow[],
    message: MessageRecord,
    ref: string,
    isPrivate: boolean,
    sent?: ItemRow[],
  ) {
    await this.setItem(ctx.tenantId, item.id, {
      status: 'imported',
      targetRef: ref,
      created: true,
      importedAt: this.clock(),
    });
    const attachments =
      sent ??
      rows.filter(
        (r) =>
          r.kind === 'attachment' &&
          ['pending', 'writing'].includes(r.status) &&
          message.attachmentIds.includes(r.sourceId),
      );
    for (const row of attachments) {
      await this.setItem(ctx.tenantId, row.id, {
        status: 'imported',
        targetRef: ref,
        created: true,
        importedAt: this.clock(),
      });
    }
    if (message.visibility === 'internal' && !isPrivate) {
      // An internal note that Chatwoot did not keep private: the reconciliation fails on it.
      await this.bumpStat(ctx.tenantId, ctx.job.id, 'notesNotPrivate');
    }
  }

  private async bumpStat(tenantId: string, jobId: string, stat: 'notesNotPrivate') {
    await this.tx(tenantId, (tx) =>
      tx
        .update(schema.migrationJobs)
        .set({
          stats: sql`jsonb_set(${schema.migrationJobs.stats}, ${`{${stat}}`}::text[], to_jsonb(coalesce((${schema.migrationJobs.stats}->>${stat})::int, 0) + 1))`,
        })
        .where(eq(schema.migrationJobs.id, jobId)),
    );
  }

  /**
   * Checks a file before upload, like any other upload: size, content matching its declared type,
   * an allowed type, and a malware scan that fails closed.
   */
  private async checkFile(
    entry: { mediaType: string },
    bytes: Uint8Array,
  ): Promise<{ problem: Reason } | { mediaType: string }> {
    if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return { problem: 'too_large' };
    const declared = entry.mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
    const unknown = declared === '' || declared === 'application/octet-stream';
    const sniffed = await fileTypeFromBuffer(bytes);
    let mediaType: string;
    if (sniffed) {
      if (!ALLOWED_TYPES.some((pattern) => pattern.test(sniffed.mime))) {
        return { problem: 'type_mismatch' };
      }
      if (!unknown && declared !== sniffed.mime) return { problem: 'type_mismatch' };
      mediaType = sniffed.mime;
    } else {
      // No signature: only plain text is accepted, and it must really be text.
      if (!unknown && !TEXT_TYPES.has(declared)) return { problem: 'type_mismatch' };
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { problem: 'type_mismatch' };
      }
      mediaType = unknown ? 'text/plain' : declared;
    }
    const verdict = await this.scanner.scan(bytes);
    if (verdict.clean) return { mediaType };
    return { problem: verdict.reason === 'malware' ? 'malware' : 'scan_unavailable' };
  }

  // ------------------------------------------------------------------ reconciliation

  private async finish(ctx: Context, state: 'completed' | 'cancelled') {
    const { tenantId, job } = ctx;
    const fresh = (await this.job(tenantId, job.id)) ?? job;
    const stats = (fresh.stats ?? {}) as JobStats;
    const tallies = await this.tally(tenantId, job.id);
    const imported = tallies.some(
      (t) => t.kind === 'conversation' && t.status === 'imported' && t.count > 0,
    );
    const verification = imported && ctx.importer ? await this.verify(ctx) : null;
    const report = reconcile({
      tallies,
      declared: stats.declared ?? null,
      found: stats.found ?? {},
      truncated: stats.truncated ?? false,
      unidentified: stats.unidentified ?? 0,
      verification: verification?.result ?? null,
      destination: {
        quietInbox: stats.quietInbox ?? true,
        contactsWithAddress: verification?.contactsWithAddress ?? 0,
        otherMessageTypes: verification?.otherMessageTypes ?? 0,
        notesNotPrivate: stats.notesNotPrivate ?? 0,
      },
    });
    const now = this.clock();
    await this.tx(tenantId, async (tx) => {
      await tx.insert(schema.reconciliationReports).values({
        tenantId,
        jobId: job.id,
        kind: 'reconciliation',
        gate: report.gate,
        report: {
          ...report,
          unsupportedFields: stats.unsupportedFields ?? [],
          samples: verification?.samples ?? [],
        },
      });
      await tx
        .update(schema.migrationJobs)
        .set({
          state,
          requestedAction: null,
          leaseUntil: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.migrationJobs.id, job.id));
      // The export stays for review and retries during the retention period, then it is purged.
      await tx
        .update(schema.migrationFiles)
        .set({
          purgeAfter: new Date(
            now.getTime() + this.config.MIGRATION_EXPORT_RETENTION_DAYS * 86_400_000,
          ),
        })
        .where(eq(schema.migrationFiles.jobId, job.id));
      await this.audit(
        tx,
        job,
        state === 'completed' ? 'migration.completed' : 'migration.cancelled',
        {
          gate: report.gate,
          conversations: report.kinds.conversation.imported,
          messages: report.kinds.message.imported,
          notes: report.kinds.note.imported,
        },
      );
    });
  }

  private async tally(tenantId: string, jobId: string): Promise<ItemTally[]> {
    const rows = await this.tx(tenantId, (tx) =>
      tx
        .select({
          kind: schema.migrationItems.kind,
          status: schema.migrationItems.status,
          reason: schema.migrationItems.reason,
          private: schema.migrationItems.private,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.migrationItems)
        .where(eq(schema.migrationItems.jobId, jobId))
        .groupBy(
          schema.migrationItems.kind,
          schema.migrationItems.status,
          schema.migrationItems.reason,
          schema.migrationItems.private,
        ),
    );
    return rows.map((r) => ({
      kind: r.kind,
      status: r.status,
      reason: (r.reason as Reason | null) ?? null,
      private: r.private,
      count: Number(r.count),
    }));
  }

  /**
   * Reads a sample of imported conversations back from Chatwoot and compares them with the
   * export: every message once, in order, with its original time and privacy; contacts without
   * an address; no messages of other kinds (greetings, surveys).
   */
  private async verify(ctx: Context): Promise<{
    result: SampleVerification;
    samples: string[];
    contactsWithAddress: number;
    otherMessageTypes: number;
  }> {
    const { tenantId, job, parsed } = ctx;
    const conversations = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, job.id),
            eq(schema.migrationItems.kind, 'conversation'),
            eq(schema.migrationItems.status, 'imported'),
          ),
        )
        .orderBy(asc(schema.migrationItems.seq))
        .limit(SAMPLE_SIZE),
    );
    const result: SampleVerification = {
      sampled: 0,
      matched: 0,
      duplicateKeys: 0,
      privacyViolations: 0,
      mismatches: [],
    };
    let contactsWithAddress = 0;
    let otherMessageTypes = 0;
    for (const conversation of conversations) {
      const source = parsed.conversations.find((c) => c.record.id === conversation.sourceId);
      if (!source || !conversation.targetRef) continue;
      result.sampled += 1;
      const rows = await this.items(tenantId, job.id, conversation.sourceId);
      const imported = rows.filter((r) => r.kind === 'message' && r.status === 'imported');
      const messages = await ctx.importer.listMessages(Number(conversation.targetRef));
      const ours = messages.filter((m) => m.key?.startsWith(`hv1:imp:${ctx.jobKey}:`));
      otherMessageTypes += messages.filter((m) => m.direction === 'template').length;
      const problems: string[] = [];
      const keys = ours.map((m) => m.key as string);
      const duplicates = keys.length - new Set(keys).size;
      result.duplicateKeys += duplicates;
      if (duplicates > 0) problems.push('duplicate_keys');
      const expected = source.messages
        .filter((m) => imported.some((r) => r.sourceId === m.id))
        .map((m) => ({ key: importMessageKey(ctx.jobKey, m.id), message: m }));
      if (keys.join('\n') !== expected.map((e) => e.key).join('\n'))
        problems.push('order_or_count');
      for (const { key, message } of expected) {
        const written = ours.find((m) => m.key === key);
        if (!written) continue;
        const original = Math.floor(new Date(message.createdAt).getTime() / 1000);
        if (Number(written.contentAttributes.external_created_at) !== original) {
          problems.push('original_time');
        }
        if (message.visibility === 'internal' && !written.private) {
          result.privacyViolations += 1;
          problems.push('private_note_public');
        }
      }
      const info = await ctx.importer.getConversation(Number(conversation.targetRef));
      const contact = info?.contactId ? await ctx.importer.getContact(info.contactId) : null;
      if (contact?.email || contact?.phone) {
        contactsWithAddress += 1;
        problems.push('contact_address');
      }
      if (problems.length === 0) result.matched += 1;
      else {
        result.mismatches.push({
          conversationSourceId: conversation.sourceId,
          problem: [...new Set(problems)].join(','),
        });
      }
    }
    return {
      result,
      samples: conversations.map((c) => c.sourceId),
      contactsWithAddress,
      otherMessageTypes,
    };
  }

  // ------------------------------------------------------------------ rollback

  /**
   * Removes what this job created in Chatwoot: its conversations (only in the import inbox), then
   * its contacts when no other conversation uses them. Nothing else is touched.
   */
  async onRollback(event: ClaimedOutboxEvent): Promise<void> {
    const { jobId } = event.payload as { jobId: string };
    const tenantId = event.tenantId;
    const job = await this.acquire(tenantId, jobId, ['rolling_back']);
    if (!job) return;
    try {
      await this.rollbackSlice(tenantId, job);
    } catch (error) {
      await this.update(tenantId, jobId, { leaseUntil: null });
      if (transient(error) && event.attempts < JOB_ATTEMPTS) throw error;
      await this.update(tenantId, jobId, {
        errorCode: 'rollback_incomplete',
        errorDetail: error instanceof ChatwootError ? `HTTP ${error.status}` : null,
      });
      throw error;
    }
  }

  /**
   * A person this job created whose conversations from a later import remain: that import takes
   * the person over (with the ID mapping), so its own rollback removes them and nothing is left.
   */
  private async handOver(tenantId: string, job: JobRow, item: ItemRow): Promise<string | null> {
    return this.tx(tenantId, async (tx) => {
      const [heir] = await tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.kind, 'contact'),
            eq(schema.migrationItems.targetRef, item.targetRef as string),
            eq(schema.migrationItems.status, 'imported'),
            ne(schema.migrationItems.jobId, job.id),
          ),
        )
        .orderBy(desc(schema.migrationItems.updatedAt))
        .limit(1);
      if (!heir) return null;
      await tx
        .update(schema.migrationItems)
        .set({ created: true, updatedAt: this.clock() })
        .where(eq(schema.migrationItems.id, heir.id));
      await tx
        .update(schema.externalIdMappings)
        .set({ jobId: heir.jobId })
        .where(
          and(
            eq(schema.externalIdMappings.jobId, job.id),
            eq(schema.externalIdMappings.kind, 'contact'),
            eq(schema.externalIdMappings.targetRef, item.targetRef as string),
          ),
        );
      return heir.jobId;
    });
  }

  private async rollbackSlice(tenantId: string, job: JobRow): Promise<void> {
    if (!job.connectionId) throw new Error('migration job without a connection');
    const runtime = await this.registry.get(tenantId, job.connectionId);
    const importer = importerFor(runtime, this.config);
    const inbox = await this.tx(tenantId, async (tx) => {
      if (!job.importInboxId) return null;
      const [row] = await tx
        .select()
        .from(schema.authorityInboxes)
        .where(eq(schema.authorityInboxes.id, job.importInboxId));
      return row ?? null;
    });
    const created = await this.tx(tenantId, (tx) =>
      tx
        .select()
        .from(schema.migrationItems)
        .where(
          and(
            eq(schema.migrationItems.jobId, job.id),
            eq(schema.migrationItems.created, true),
            inArray(schema.migrationItems.status, ['imported', 'writing']),
            inArray(schema.migrationItems.kind, ['conversation', 'contact']),
          ),
        ),
    );
    let kept = 0;
    const deleted = new Set<number>();
    for (const item of created.filter((i) => i.kind === 'conversation' && i.targetRef)) {
      const conversationId = Number(item.targetRef);
      const current = await importer.getConversation(conversationId);
      if (current && inbox && current.inboxId !== inbox.externalInboxId) {
        // Never delete a conversation outside the import inbox.
        kept += 1;
        await this.setItem(tenantId, item.id, { detail: 'kept: not in the import inbox' });
        continue;
      }
      if (current) await importer.deleteConversation(conversationId);
      deleted.add(conversationId);
      await this.tx(tenantId, (tx) =>
        tx
          .update(schema.migrationItems)
          .set({ status: 'rolled_back', updatedAt: this.clock() })
          .where(
            and(
              eq(schema.migrationItems.jobId, job.id),
              eq(schema.migrationItems.conversationSourceId, item.sourceId),
              inArray(schema.migrationItems.status, ['imported', 'writing']),
            ),
          ),
      );
    }
    for (const item of created.filter((i) => i.kind === 'contact' && i.targetRef)) {
      const contactId = Number(item.targetRef);
      const others = (await importer.listContactConversations(contactId).catch(() => [])).filter(
        (c) => !deleted.has(c.id),
      );
      if (others.length > 0) {
        kept += 1;
        const heir = await this.handOver(tenantId, job, item);
        await this.setItem(tenantId, item.id, {
          detail: heir
            ? `kept: used by ${toPublicId('migration', heir)}`
            : 'kept: has other conversations',
        });
        continue;
      }
      await importer.deleteContact(contactId);
      await this.setItem(tenantId, item.id, { status: 'rolled_back' });
    }
    const tallies = await this.tally(tenantId, job.id);
    const now = this.clock();
    await this.tx(tenantId, async (tx) => {
      await tx.delete(schema.externalIdMappings).where(eq(schema.externalIdMappings.jobId, job.id));
      const rolledBack = (kind: string) =>
        tallies
          .filter((t) => t.kind === kind && t.status === 'rolled_back')
          .reduce((sum, t) => sum + t.count, 0);
      const report = reconcile({
        tallies,
        declared: null,
        found: {},
        truncated: false,
        unidentified: 0,
        verification: null,
        destination: {
          quietInbox: true,
          contactsWithAddress: 0,
          otherMessageTypes: 0,
          notesNotPrivate: 0,
        },
      });
      await tx.insert(schema.reconciliationReports).values({
        tenantId,
        jobId: job.id,
        kind: 'rollback',
        gate: kept === 0 ? 'passed' : 'failed',
        report: {
          ...report,
          checks: [
            { code: 'nothing_left', ok: kept === 0, ...(kept ? { detail: `${kept} kept` } : {}) },
          ],
          unsupportedFields: [],
          samples: [],
        },
      });
      await tx
        .update(schema.migrationJobs)
        .set({ state: 'rolled_back', leaseUntil: null, finishedAt: now, updatedAt: now })
        .where(eq(schema.migrationJobs.id, job.id));
      await tx
        .update(schema.migrationFiles)
        .set({ purgeAfter: now })
        .where(eq(schema.migrationFiles.jobId, job.id));
      await this.audit(tx, job, 'migration.rolled_back', {
        conversations: rolledBack('conversation'),
        contacts: rolledBack('contact'),
        kept,
      });
    });
  }
}

function flat(value: unknown): string | number | boolean | null {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 500);
}

function contactAttributes(ctx: Context, contact: ContactRecord) {
  const attributes: Record<string, string | number | boolean | null> = {
    hv_import_job: ctx.jobKey,
    hv_import_source: ctx.job.sourceSystem,
  };
  // Typed-in addresses are kept for reference only: Chatwoot never gets them as email or phone,
  // so it cannot merge people by them or message them.
  if (contact.unverified.email) attributes.hv_unverified_email = contact.unverified.email;
  if (contact.unverified.phone) attributes.hv_unverified_phone = contact.unverified.phone;
  if (contact.verified) attributes.hv_verified_subject = contact.verified.subject;
  if (contact.location?.city) attributes.hv_city = contact.location.city;
  if (contact.location?.countryCode) attributes.hv_country = contact.location.countryCode;
  for (const [key, value] of Object.entries(contact.attributes).slice(0, 30)) {
    attributes[`hv_src_${key}`.slice(0, 64)] = flat(value);
  }
  return attributes;
}

function conversationAttributes(ctx: Context, conversation: ParsedConversation) {
  const { record } = conversation;
  const attributes: Record<string, string | number | boolean | null> = {
    hv_import_job: ctx.jobKey,
    hv_import_source: ctx.job.sourceSystem,
    hv_source_id: record.id.slice(0, 200),
    hv_started_at: record.startedAt,
  };
  if (record.endedAt) attributes.hv_ended_at = record.endedAt;
  if (record.subject) attributes.hv_subject = record.subject;
  if (record.assignee?.name) attributes.hv_assignee = record.assignee.name;
  if (record.labels.length > 0) attributes.hv_labels = record.labels.join(', ');
  for (const [key, value] of Object.entries(record.attributes).slice(0, 30)) {
    attributes[`hv_src_${key}`.slice(0, 64)] = flat(value);
  }
  return attributes;
}
