/** Imports and exports (board 18): API shapes, queries and downloads. */
import type * as C from '@hamnivo/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';
import { API_BASE } from './config';
import { useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items, Problem } from './types';

export type MigrationJob = C.MigrationJob;
export type MigrationState = MigrationJob['state'];
export type MigrationPreflight = NonNullable<MigrationJob['preflight']>;
export type MigrationDryRun = NonNullable<MigrationJob['dryRun']>;
export type MigrationReport = NonNullable<MigrationJob['report']>;
export type MigrationItem = C.MigrationItem;
export type MigrationSample = C.MigrationSample;
export type MigrationSourceInfo = C.MigrationSourceInfo;
export type ImportSource = 'tawk.to' | 'hamnivo';

/** Largest export as one upload, the same as MIGRATION_MAX_BYTES in @hamnivo/contracts. */
export const MIGRATION_MAX_BYTES = 20 * 1024 * 1024;
export const ACCEPTED_EXPORTS = '.zip,.json,.ndjson,.jsonl,application/zip,application/json';

export const acceptedExport = (file: File) => /\.(zip|json|ndjson|jsonl)$/i.test(file.name);

/** States in which the worker is still doing something: the page checks again every 2 s. */
const WORKING = new Set<MigrationState>([
  'scanning',
  'dry_running',
  'queued',
  'running',
  'rolling_back',
]);
export const isWorking = (job: MigrationJob | undefined) =>
  Boolean(job && (WORKING.has(job.state) || job.requestedAction));

/** The wizard step a job is at: 1 source, 2 check, 3 review sample, 4 import. */
export function stepOf(job: MigrationJob): 1 | 2 | 3 | 4 {
  if (['scanning', 'rejected', 'blocked', 'ready'].includes(job.state)) return 2;
  if (['dry_running', 'dry_run_ready'].includes(job.state)) return 3;
  if (job.state === 'cancelled' && !job.startedAt) return job.dryRun ? 3 : 2;
  return 4;
}

export const migrationKeys = {
  all: ['migrations'],
  sources: ['migrations', 'sources'],
  job: (id: string) => ['migrations', id],
  items: (id: string, status: string) => ['migrations', id, 'items', status],
  sample: (id: string, conversation: string) => ['migrations', id, 'samples', conversation],
} as const;

export function useMigrations() {
  const { can } = useTenant();
  return useStudioQuery<Items<MigrationJob>>(migrationKeys.all, '/v1/admin/migrations', {
    enabled: can('migration.review'),
    refetchInterval: (data) => ((data?.items ?? []).some(isWorking) ? 3000 : false),
  });
}

export function useMigration(id: string | undefined) {
  const { can } = useTenant();
  return useStudioQuery<MigrationJob>(
    migrationKeys.job(id ?? 'none'),
    `/v1/admin/migrations/${id}`,
    {
      enabled: Boolean(id) && can('migration.review'),
      refetchInterval: (data) => (isWorking(data) ? 2000 : false),
    },
  );
}

export function useMigrationSources() {
  const { can } = useTenant();
  return useStudioQuery<Items<MigrationSourceInfo>>(
    migrationKeys.sources,
    '/v1/admin/migrations/sources',
    { enabled: can('migration.review') },
  );
}

export function useMigrationSample(
  id: string,
  conversationId: string | undefined,
  version: string,
) {
  return useStudioQuery<MigrationSample>(
    [...migrationKeys.sample(id, conversationId ?? 'none'), version],
    `/v1/admin/migrations/${id}/samples/${encodeURIComponent(conversationId ?? '')}`,
    { enabled: Boolean(conversationId) },
  );
}

/** Records that were not imported, 50 at a time. */
export function useMigrationProblems(id: string, version: string) {
  const { tenantId } = useTenant();
  return useInfiniteQuery({
    queryKey: [tenantId, ...migrationKeys.items(id, 'problems'), version],
    queryFn: ({ pageParam, signal }) => {
      const query = new URLSearchParams({ status: 'problems', limit: '50' });
      if (pageParam) query.set('cursor', pageParam);
      return api<{ items: MigrationItem[]; nextCursor: string | null }>(
        `/v1/admin/migrations/${id}/items?${query}`,
        { tenant: tenantId, signal },
      );
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { studio: true },
  });
}

/** Saves a file the gateway sends (a CSV or a ZIP), keeping the name it suggests. */
export async function downloadFile(path: string, tenantId: string, fallbackName: string) {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { 'x-hamnivo-tenant': tenantId },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', null);
  }
  if (!response.ok) {
    let problem: Problem | null = null;
    try {
      problem = (await response.json()) as Problem;
    } catch {
      problem = null;
    }
    throw new ApiError(
      response.status,
      problem?.code ?? (response.status === 404 ? 'NOT_FOUND' : 'UNKNOWN'),
      problem,
    );
  }
  const disposition = response.headers.get('content-disposition') ?? '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  saveBlob(await response.blob(), name);
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
