import { WebSourcesController } from './sources.controller.js';
import { WebSourcesService } from './sources.service.js';
import { WebSyncService } from './sync.service.js';
import { WebSyncWorker } from './worker.service.js';

/**
 * Websites as knowledge (G04, G17). The API process adds and changes websites; the worker reads
 * them on their schedule, apart from the outbox relay, and hands every page to the ordinary
 * ingestion.
 */
export const KNOWLEDGE_WEB_API_CONTROLLERS = [WebSourcesController];

export const KNOWLEDGE_WEB_API_PROVIDERS = [WebSourcesService];

export const KNOWLEDGE_WEB_WORKER_PROVIDERS = [WebSyncService, WebSyncWorker];
