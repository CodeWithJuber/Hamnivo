import type {
  MigrationDryRun,
  MigrationItem,
  MigrationJob,
  MigrationPreflight,
  MigrationProgress,
  MigrationReport,
} from '@hamnivo/contracts';
import { schema, type TenantTx, toPublicId } from '@hamnivo/db';
import type { Reconciliation } from '@hamnivo/migration-sdk';
import { eq, inArray, sql } from 'drizzle-orm';
import { iso } from '../common/views.js';

export type JobRow = typeof schema.migrationJobs.$inferSelect;
export type ItemRow = typeof schema.migrationItems.$inferSelect;
export type ReportRow = typeof schema.reconciliationReports.$inferSelect;

/** Where a resumed import continues (stored in migration_jobs.checkpoint). */
export interface Checkpoint {
  planned?: boolean;
  /** Next conversation to work on, in import order. */
  index?: number;
  total?: number;
  at?: string;
  /** The import inbox was checked to be quiet before the first write. */
  inboxVerified?: boolean;
  /** Rollback progress. */
  rollbackStage?: 'conversations' | 'contacts' | 'done';
}

/** Facts the worker records while writing (migration_jobs.stats). */
export interface JobStats {
  notesNotPrivate?: number;
  otherMessageTypes?: number;
  contactsWithAddress?: number;
  quietInbox?: boolean;
  unsupportedFields?: Array<{ path: string; count: number }>;
  unidentified?: number;
  found?: { contacts?: number; conversations?: number; messages?: number; attachments?: number };
  declared?: { contacts?: number; conversations?: number; messages?: number; attachments?: number };
  truncated?: boolean;
  /** API sources: the token's role, and conversations passed over as already imported. */
  sourceRole?: string | null;
  sourceSkipped?: number;
  sourceTruncated?: boolean;
}

export type Tally = { jobId: string; kind: string; status: string; count: number };

const EMPTY = {
  total: 0,
  imported: 0,
  skipped: 0,
  quarantined: 0,
  failed: 0,
  pending: 0,
  rolledBack: 0,
};

export function progressOf(job: JobRow, tallies: Tally[]): MigrationProgress {
  const kinds = {
    conversations: { ...EMPTY },
    messages: { ...EMPTY },
    contacts: { ...EMPTY },
    attachments: { ...EMPTY },
  };
  const key = {
    conversation: 'conversations',
    message: 'messages',
    contact: 'contacts',
    attachment: 'attachments',
  } as const;
  for (const tally of tallies) {
    if (tally.jobId !== job.id) continue;
    const counts = kinds[key[tally.kind as keyof typeof key]];
    if (!counts) continue;
    counts.total += tally.count;
    if (tally.status === 'imported') counts.imported += tally.count;
    else if (tally.status === 'skipped') counts.skipped += tally.count;
    else if (tally.status === 'quarantined') counts.quarantined += tally.count;
    else if (tally.status === 'failed') counts.failed += tally.count;
    else if (tally.status === 'rolled_back') counts.rolledBack += tally.count;
    else counts.pending += tally.count;
  }
  const checkpoint = job.checkpoint as Checkpoint;
  return {
    ...kinds,
    checkpoint: {
      conversation: checkpoint.index ?? 0,
      of: checkpoint.total ?? kinds.conversations.total,
      at: checkpoint.at ?? null,
    },
  };
}

export async function tallies(tx: TenantTx, jobIds: string[]): Promise<Tally[]> {
  if (jobIds.length === 0) return [];
  const rows = await tx
    .select({
      jobId: schema.migrationItems.jobId,
      kind: schema.migrationItems.kind,
      status: schema.migrationItems.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.migrationItems)
    .where(inArray(schema.migrationItems.jobId, jobIds))
    .groupBy(schema.migrationItems.jobId, schema.migrationItems.kind, schema.migrationItems.status);
  return rows.map((r) => ({ ...r, count: Number(r.count) }));
}

export function reportView(row: ReportRow): MigrationReport {
  const report = row.report as Reconciliation & {
    unsupportedFields?: Array<{ path: string; count: number }>;
    samples?: string[];
  };
  return {
    id: row.id,
    kind: row.kind,
    gate: row.gate,
    kinds: report.kinds,
    reasons: report.reasons,
    missingFromExport: report.missingFromExport ?? {},
    unidentified: report.unidentified ?? 0,
    checks: report.checks,
    unsupportedFields: report.unsupportedFields ?? [],
    samples: report.samples ?? [],
    createdAt: row.createdAt.toISOString(),
    approvedAt: iso(row.approvedAt),
    acknowledged: row.acknowledged,
  };
}

export function jobView(
  job: JobRow,
  context: {
    tallies: Tally[];
    report: ReportRow | null;
    exportAvailable: boolean;
    packageAvailable: boolean;
    file: MigrationJob['file'];
  },
): MigrationJob {
  return {
    id: toPublicId('migration', job.id),
    workspaceId: toPublicId('workspace', job.workspaceId),
    brandId: toPublicId('brand', job.brandId),
    kind: (job.options as { kind?: string }).kind === 'export' ? 'export' : 'import',
    source: job.sourceSystem,
    sourceKind: job.sourceKind,
    label: job.label,
    state: job.state,
    requestedAction: job.requestedAction,
    preflight: (job.preflight as MigrationPreflight | null) ?? null,
    dryRun: (job.dryRun as MigrationDryRun | null) ?? null,
    progress: progressOf(job, context.tallies),
    report: context.report ? reportView(context.report) : null,
    error: job.errorCode ? { code: job.errorCode, detail: job.errorDetail } : null,
    exportAvailable: context.exportAvailable,
    packageAvailable: context.packageAvailable,
    file: context.file,
    createdBy: job.createdBy ? toPublicId('staff', job.createdBy) : null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
    closedAt: iso(job.closedAt),
  };
}

/** Views of several jobs with their counts, latest reports and file availability. */
export async function jobViews(tx: TenantTx, jobs: JobRow[]): Promise<MigrationJob[]> {
  const ids = jobs.map((j) => j.id);
  if (ids.length === 0) return [];
  const counts = await tallies(tx, ids);
  const reports = await tx
    .select()
    .from(schema.reconciliationReports)
    .where(inArray(schema.reconciliationReports.jobId, ids))
    .orderBy(sql`${schema.reconciliationReports.createdAt} desc`);
  // Never the bytes themselves: only whether they are still kept.
  const files = await tx
    .select({
      jobId: schema.migrationFiles.jobId,
      purpose: schema.migrationFiles.purpose,
      name: schema.migrationFiles.name,
      byteSize: schema.migrationFiles.byteSize,
      createdAt: schema.migrationFiles.createdAt,
      kept: sql<boolean>`${schema.migrationFiles.raw} is not null`,
    })
    .from(schema.migrationFiles)
    .where(inArray(schema.migrationFiles.jobId, ids));
  return jobs.map((job) => {
    const own = files.filter((f) => f.jobId === job.id);
    const upload =
      own.find((f) => f.purpose === 'export') ?? own.find((f) => f.purpose === 'package');
    return jobView(job, {
      tallies: counts,
      report: reports.find((r) => r.jobId === job.id) ?? null,
      exportAvailable: own.some((f) => f.purpose === 'export' && f.kept),
      packageAvailable: own.some((f) => f.purpose === 'package' && f.kept),
      file: upload
        ? {
            name: upload.name,
            byteSize: Number(upload.byteSize),
            uploadedAt: upload.createdAt.toISOString(),
          }
        : null,
    });
  });
}

export function itemView(row: ItemRow): MigrationItem {
  return {
    kind: row.kind,
    sourceId: row.sourceId,
    conversationSourceId: row.conversationSourceId,
    status: row.status,
    reason: row.reason,
    detail: row.detail,
    private: row.private,
    targetRef: row.targetRef,
    attempts: row.attempts,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function latestReport(tx: TenantTx, jobId: string): Promise<ReportRow | null> {
  const [row] = await tx
    .select()
    .from(schema.reconciliationReports)
    .where(eq(schema.reconciliationReports.jobId, jobId))
    .orderBy(sql`${schema.reconciliationReports.createdAt} desc`)
    .limit(1);
  return row ?? null;
}
