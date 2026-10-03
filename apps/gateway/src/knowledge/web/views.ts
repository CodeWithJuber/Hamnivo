import { type KnowledgeWebPage, type KnowledgeWebSource, WebSyncSummary } from '@hamnivo/contracts';
import { type schema, toPublicId } from '@hamnivo/db';
import { iso } from '../../common/views.js';

export type WebSourceRow = typeof schema.knowledgeWebSources.$inferSelect;
export type WebPageRow = typeof schema.knowledgeWebPages.$inferSelect;
type SourceRow = typeof schema.knowledgeSources.$inferSelect;

export function webSourceView(
  web: WebSourceRow,
  source: SourceRow,
  pageCount: number,
): KnowledgeWebSource {
  const run = WebSyncSummary.safeParse(web.lastRun);
  return {
    id: toPublicId('webSource', web.id),
    sourceId: toPublicId('source', source.id),
    brandId: toPublicId('brand', source.brandId),
    name: source.name,
    visibility: source.visibility,
    status: source.status,
    url: web.startUrl,
    mode: web.mode,
    maxPages: web.maxPages,
    maxDepth: web.maxDepth,
    schedule: web.schedule,
    state: web.state,
    nextRunAt: iso(web.nextRunAt),
    lastRunAt: iso(web.lastRunAt),
    lastResult: web.lastResult,
    lastRun: run.success ? run.data : null,
    pageCount,
    createdAt: web.createdAt.toISOString(),
  };
}

export function webPageView(row: WebPageRow): KnowledgeWebPage {
  return {
    url: row.url,
    documentId: row.documentId ? toPublicId('document', row.documentId) : null,
    state: row.goneAt ? 'gone' : row.lastError ? 'failed' : 'ok',
    status: row.lastStatus,
    lastFetchedAt: iso(row.lastFetchedAt),
    error: row.lastError,
  };
}
