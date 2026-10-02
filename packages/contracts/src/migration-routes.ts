import { z } from 'zod';
import { Cursor } from './common.js';
import {
  ApproveCutoverRequest,
  CreateMigrationExportRequest,
  CreateMigrationRequest,
  MigrationItem,
  MigrationItemQuery,
  MigrationJob,
  MigrationReport,
  MigrationSample,
  MigrationSourceInfo,
  StartMigrationRequest,
} from './migration.js';
import type { RouteDef } from './routes.js';

const jobParams = z.object({
  migrationId: z.string().meta({ description: 'Migration job ID (mig_…)' }),
});
const sampleParams = jobParams.extend({
  conversationId: z.string().meta({ description: 'Conversation ID in the source export' }),
});

const action = (name: string, path: string, summary: string, body?: z.ZodType): RouteDef => ({
  method: 'post',
  path: `/v1/admin/migrations/{migrationId}/${path}`,
  operationId: name,
  summary,
  tags: ['Migration'],
  auth: 'staff_session',
  params: jobParams,
  ...(body ? { body } : {}),
  success: { status: 202, description: 'Job', schema: MigrationJob },
});

/** Imports from other platforms, reconciliation, rollback and export (M01–M08). */
export const migrationRoutes = {
  listMigrationSources: {
    method: 'get',
    path: '/v1/admin/migrations/sources',
    operationId: 'listMigrationSources',
    summary: 'Supported sources, the fields each maps and their known limits (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Sources',
      schema: z.object({ items: z.array(MigrationSourceInfo) }),
    },
  },
  listMigrations: {
    method: 'get',
    path: '/v1/admin/migrations',
    operationId: 'listMigrations',
    summary: 'Import and export jobs of the tenant, newest first (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    success: {
      status: 200,
      description: 'Jobs',
      schema: z.object({ items: z.array(MigrationJob) }),
    },
  },
  createMigration: {
    method: 'post',
    path: '/v1/admin/migrations',
    operationId: 'createMigration',
    summary:
      'Upload an export; it is quarantined, scanned and checked before anything is imported (migration.run)',
    tags: ['Migration'],
    auth: 'staff_session',
    body: CreateMigrationRequest,
    idempotent: true,
    success: { status: 202, description: 'Job created', schema: MigrationJob },
  },
  createMigrationExport: {
    method: 'post',
    path: '/v1/admin/migrations/exports',
    operationId: 'createMigrationExport',
    summary:
      "Export a brand's conversations from Chatwoot as a Hamnivo package (conversations.export)",
    tags: ['Migration'],
    auth: 'staff_session',
    body: CreateMigrationExportRequest,
    idempotent: true,
    success: { status: 202, description: 'Export job created', schema: MigrationJob },
  },
  getMigration: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}',
    operationId: 'getMigration',
    summary: 'A job with its preflight, dry run, progress and latest report (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: jobParams,
    success: { status: 200, description: 'Job', schema: MigrationJob },
  },
  checkMigration: action(
    'checkMigration',
    'preflight',
    'Run the destination and permission checks again (migration.run)',
  ),
  dryRunMigration: action(
    'dryRunMigration',
    'dry-run',
    'Count what an import would do and find duplicates, without writing anything (migration.run)',
  ),
  startMigration: action(
    'startMigration',
    'start',
    'Start the import after a dry run (migration.run)',
    StartMigrationRequest,
  ),
  pauseMigration: action('pauseMigration', 'pause', 'Pause at the next checkpoint (migration.run)'),
  resumeMigration: action(
    'resumeMigration',
    'resume',
    'Continue from the last checkpoint (migration.run)',
  ),
  cancelMigration: action(
    'cancelMigration',
    'cancel',
    'Stop the import; what was imported stays until rolled back (migration.run)',
  ),
  retryMigration: action(
    'retryMigration',
    'retry',
    'Retry only the objects that failed; imported ones are not sent again (migration.run)',
  ),
  rollbackMigration: action(
    'rollbackMigration',
    'rollback',
    'Remove what this import created in Chatwoot; nothing else is touched (migration.manage)',
  ),
  approveMigrationCutover: action(
    'approveMigrationCutover',
    'cutover',
    'Approve the reconciled import and close the job (migration.manage)',
    ApproveCutoverRequest,
  ),
  listMigrationItems: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}/items',
    operationId: 'listMigrationItems',
    summary: 'Objects of the job with their status and reason, no content (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: jobParams,
    query: MigrationItemQuery,
    success: {
      status: 200,
      description: 'Items',
      schema: z.object({ items: z.array(MigrationItem), nextCursor: Cursor.nullable() }),
    },
  },
  downloadMigrationRejections: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}/rejections',
    operationId: 'downloadMigrationRejections',
    summary: 'Objects that were not imported, with reasons, as CSV (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: jobParams,
    success: { status: 200, description: 'CSV', contentType: 'text/csv' },
  },
  getMigrationSample: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}/samples/{conversationId}',
    operationId: 'getMigrationSample',
    summary:
      'A conversation from the export beside what Chatwoot holds, redacted (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: sampleParams,
    success: { status: 200, description: 'Sample', schema: MigrationSample },
  },
  listMigrationReports: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}/reports',
    operationId: 'listMigrationReports',
    summary: 'Reconciliation and rollback reports, newest first (migration.review)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: jobParams,
    success: {
      status: 200,
      description: 'Reports',
      schema: z.object({ items: z.array(MigrationReport) }),
    },
  },
  downloadMigrationPackage: {
    method: 'get',
    path: '/v1/admin/migrations/{migrationId}/package',
    operationId: 'downloadMigrationPackage',
    summary: 'The package an export job produced (conversations.export)',
    tags: ['Migration'],
    auth: 'staff_session',
    params: jobParams,
    success: { status: 200, description: 'ZIP package', contentType: 'application/zip' },
  },
} as const satisfies Record<string, RouteDef>;
