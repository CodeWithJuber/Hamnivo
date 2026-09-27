import { z } from 'zod';
import { Timestamp } from './common.js';
import { typeId } from './ids.js';

/** Migration (M01–M08): imports into Chatwoot through Hamnivo, reviewed in Studio. */

export const MigrationSource = z.enum(['tawk.to', 'hamnivo', 'chatwoot', 'intercom', 'zendesk']);
export type MigrationSource = z.infer<typeof MigrationSource>;

export const MigrationJobState = z.enum([
  'scanning',
  'rejected',
  'blocked',
  'ready',
  'dry_running',
  'dry_run_ready',
  'queued',
  'running',
  'paused',
  'cancelled',
  'completed',
  'failed',
  'rolling_back',
  'rolled_back',
  'closed',
]);
export type MigrationJobState = z.infer<typeof MigrationJobState>;

/** Largest export accepted as one upload (sent as base64). */
export const MIGRATION_MAX_BYTES = 20 * 1024 * 1024;

const FieldStatus = z.enum(['supported', 'transformed', 'unsupported']);

export const MigrationSourceInfo = z
  .object({
    system: MigrationSource,
    accepts: z.array(z.enum(['zip', 'json', 'ndjson', 'api'])),
    /** False when this server cannot use the source (for example an API needing approval). */
    available: z.boolean(),
    fields: z.array(
      z.object({
        source: z.string(),
        target: z.string(),
        status: FieldStatus,
        required: z.boolean().optional(),
      }),
    ),
    limits: z.array(z.object({ code: z.string(), severity: z.enum(['info', 'warning']) })),
  })
  .meta({ id: 'MigrationSourceInfo' });
export type MigrationSourceInfo = z.infer<typeof MigrationSourceInfo>;

export const CreateMigrationRequest = z
  .object({
    brandId: typeId('brand'),
    source: z.enum(['tawk.to', 'hamnivo']),
    file: z.object({
      name: z.string().trim().min(1).max(200),
      base64: z
        .string()
        .min(4)
        .max(Math.ceil((MIGRATION_MAX_BYTES * 4) / 3) + 4),
    }),
  })
  .meta({ id: 'CreateMigrationRequest' });

const IssueExample = z.object({
  kind: z.enum(['contact', 'conversation', 'message', 'attachment']).optional(),
  sourceId: z.string().optional(),
  location: z.string().optional(),
  detail: z.string().optional(),
});

export const MigrationIssue = z
  .object({
    code: z.string(),
    severity: z.enum(['error', 'warning']),
    count: z.int().nonnegative(),
    examples: z.array(IssueExample),
  })
  .meta({ id: 'MigrationIssue' });

const PartialCounts = z.object({
  contacts: z.int().nonnegative().optional(),
  conversations: z.int().nonnegative().optional(),
  messages: z.int().nonnegative().optional(),
  attachments: z.int().nonnegative().optional(),
});

/** A readiness check of the destination or of the person running the import. */
export const PreflightCheck = z.object({
  code: z.string(),
  status: z.enum(['ok', 'warning', 'blocked']),
  detail: z.string().optional(),
});

/** Shown before anything is imported (M01). No message content. */
export const MigrationPreflight = z
  .object({
    source: z.object({
      system: MigrationSource,
      schemaVersion: z.string().nullable(),
      files: z.int().nonnegative(),
    }),
    /** The file looks like an export from another source than the one chosen. */
    detected: MigrationSource.nullable(),
    counts: z.object({
      contacts: z.int().nonnegative(),
      conversations: z.int().nonnegative(),
      messages: z.int().nonnegative(),
      internalNotes: z.int().nonnegative(),
      attachments: z.int().nonnegative(),
      attachmentFiles: z.int().nonnegative(),
    }),
    declared: PartialCounts.nullable(),
    truncated: z.boolean(),
    fields: z.array(
      z.object({
        path: z.string(),
        count: z.int().nonnegative(),
        types: z.array(z.string()),
        status: FieldStatus,
        target: z.string().nullable(),
      }),
    ),
    missingRequired: z.array(z.string()),
    limits: z.array(z.object({ code: z.string(), severity: z.enum(['info', 'warning']) })),
    issues: z.array(MigrationIssue),
    checks: z.array(PreflightCheck),
    blocking: z.boolean(),
    checkedAt: Timestamp,
  })
  .meta({ id: 'MigrationPreflight' });
export type MigrationPreflight = z.infer<typeof MigrationPreflight>;

const DryRunCounts = z.object({
  total: z.int().nonnegative(),
  ready: z.int().nonnegative(),
  duplicates: z.int().nonnegative(),
  needsReview: z.int().nonnegative(),
});

/** What the import would do; nothing was written (HNV-18-03). */
export const MigrationDryRun = z
  .object({
    conversations: DryRunCounts,
    messages: DryRunCounts.extend({ internal: z.int().nonnegative() }),
    contacts: DryRunCounts,
    attachments: DryRunCounts,
    duplicatesInFile: z.int().nonnegative(),
    unidentified: z.int().nonnegative(),
    identity: z.object({ verified: z.int().nonnegative(), unverified: z.int().nonnegative() }),
    truncated: z.boolean(),
    samples: z.array(z.string()),
    checkedAt: Timestamp,
  })
  .meta({ id: 'MigrationDryRun' });
export type MigrationDryRun = z.infer<typeof MigrationDryRun>;

const KindProgress = z.object({
  total: z.int().nonnegative(),
  imported: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  quarantined: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  pending: z.int().nonnegative(),
  rolledBack: z.int().nonnegative(),
});

export const MigrationProgress = z
  .object({
    conversations: KindProgress,
    messages: KindProgress,
    contacts: KindProgress,
    attachments: KindProgress,
    /** Where a resumed import continues: conversation N of M, as of this time. */
    checkpoint: z.object({
      conversation: z.int().nonnegative(),
      of: z.int().nonnegative(),
      at: Timestamp.nullable(),
    }),
  })
  .meta({ id: 'MigrationProgress' });
export type MigrationProgress = z.infer<typeof MigrationProgress>;

const ReportCounts = z.object({
  discovered: z.int().nonnegative(),
  imported: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  quarantined: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  pending: z.int().nonnegative(),
  rolledBack: z.int().nonnegative(),
});

/** Reconciliation or rollback report (M08): counts per kind and checks, never content. */
export const MigrationReport = z
  .object({
    id: z.string(),
    kind: z.enum(['reconciliation', 'rollback']),
    gate: z.enum(['passed', 'failed']),
    kinds: z.object({
      contact: ReportCounts,
      conversation: ReportCounts,
      message: ReportCounts,
      note: ReportCounts,
      attachment: ReportCounts,
    }),
    reasons: z.array(z.object({ kind: z.string(), reason: z.string(), count: z.int() })),
    missingFromExport: PartialCounts,
    unidentified: z.int().nonnegative(),
    checks: z.array(z.object({ code: z.string(), ok: z.boolean(), detail: z.string().optional() })),
    unsupportedFields: z.array(z.object({ path: z.string(), count: z.int().nonnegative() })),
    /** Conversations read back from Chatwoot and compared with the export. */
    samples: z.array(z.string()),
    createdAt: Timestamp,
    approvedAt: Timestamp.nullable(),
    acknowledged: z.boolean(),
  })
  .meta({ id: 'MigrationReport' });
export type MigrationReport = z.infer<typeof MigrationReport>;

export const MigrationJob = z
  .object({
    id: typeId('migration'),
    workspaceId: typeId('workspace'),
    brandId: typeId('brand'),
    source: MigrationSource,
    sourceKind: z.enum(['file', 'api']),
    label: z.string(),
    state: MigrationJobState,
    /** A pause or cancel the worker applies at its next checkpoint. */
    requestedAction: z.enum(['pause', 'cancel']).nullable(),
    preflight: MigrationPreflight.nullable(),
    dryRun: MigrationDryRun.nullable(),
    progress: MigrationProgress,
    report: MigrationReport.nullable(),
    error: z.object({ code: z.string(), detail: z.string().nullable() }).nullable(),
    /** The uploaded export is still kept (samples and retries need it). */
    exportAvailable: z.boolean(),
    /** A package generated by an export job can be downloaded. */
    packageAvailable: z.boolean(),
    createdBy: typeId('staff').nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
    closedAt: Timestamp.nullable(),
  })
  .meta({ id: 'MigrationJob' });
export type MigrationJob = z.infer<typeof MigrationJob>;

export const MigrationItemStatus = z.enum([
  'pending',
  'writing',
  'imported',
  'skipped',
  'quarantined',
  'failed',
  'rolled_back',
]);

/** One source object and what became of it (no content). */
export const MigrationItem = z
  .object({
    kind: z.enum(['contact', 'conversation', 'message', 'attachment']),
    sourceId: z.string(),
    conversationSourceId: z.string().nullable(),
    status: MigrationItemStatus,
    reason: z.string().nullable(),
    detail: z.string().nullable(),
    private: z.boolean(),
    targetRef: z.string().nullable(),
    attempts: z.int().nonnegative(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'MigrationItem' });
export type MigrationItem = z.infer<typeof MigrationItem>;

export const MigrationItemQuery = z.object({
  status: z.enum(['failed', 'quarantined', 'skipped', 'imported', 'problems']).optional(),
  kind: z.enum(['contact', 'conversation', 'message', 'attachment']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const SampleMessage = z.object({
  sourceId: z.string().nullable(),
  author: z.object({
    kind: z.enum(['customer', 'agent', 'bot', 'system']),
    name: z.string().nullable(),
  }),
  visibility: z.enum(['public', 'internal']),
  /** Redacted: emails, phone numbers and link parameters are masked. */
  text: z.string().nullable(),
  /** Original time in the source. */
  createdAt: Timestamp.nullable(),
  /** When Chatwoot stored it (imported side only). */
  importedAt: Timestamp.nullable(),
  attachments: z.array(
    z.object({ name: z.string(), status: MigrationItemStatus, reason: z.string().nullable() }),
  ),
});

const SampleConversation = z.object({
  sourceId: z.string(),
  startedAt: Timestamp.nullable(),
  contactName: z.string().nullable(),
  messages: z.array(SampleMessage),
});

/** One conversation from the export beside what Chatwoot now holds (sample review, M08). */
export const MigrationSample = z
  .object({
    source: SampleConversation,
    imported: SampleConversation.nullable(),
    /** Null when nothing was imported yet. */
    comparison: z.object({ matches: z.boolean(), problems: z.array(z.string()) }).nullable(),
  })
  .meta({ id: 'MigrationSample' });
export type MigrationSample = z.infer<typeof MigrationSample>;

export const StartMigrationRequest = z
  .object({
    /** Conversations already imported by an earlier job are skipped; originals stay unchanged. */
    duplicates: z.enum(['skip']).default('skip'),
  })
  .meta({ id: 'StartMigrationRequest' });

export const ApproveCutoverRequest = z
  .object({
    /** Required when a reconciliation check failed: the person accepts the listed gaps. */
    acknowledgeFailedChecks: z.boolean().default(false),
  })
  .meta({ id: 'ApproveCutoverRequest' });

export const CreateMigrationExportRequest = z
  .object({ brandId: typeId('brand') })
  .meta({ id: 'CreateMigrationExportRequest' });
