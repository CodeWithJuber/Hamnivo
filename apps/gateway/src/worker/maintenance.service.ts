import {
  type Db,
  ensureAuditPartitions,
  ensureReconcileCursors,
  purgeAutomationRuns,
  purgeExpired,
  purgeMigrationFiles,
  purgeVisitors,
  purgeWebhookEvents,
  purgeWidgetUploads,
} from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AppConfig } from '../config.js';
import { MemoryDeletionService } from '../memory/deletion.service.js';
import { APP_DB, CONFIG, REDIS } from '../tokens.js';

const QUEUE = 'hamnivo-maintenance';

/**
 * Scheduled upkeep through BullMQ job schedulers: audit partitions daily; expiry purge and
 * reconciler cursors every ten minutes; memory past its retention hourly; memory tombstones
 * replayed daily (a safety net after restores); webhook event bodies past their retention cleared,
 * and the delivery log past WEBHOOK_LOG_DAYS deleted, hourly.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly memory: MemoryDeletionService,
  ) {}

  async run(job: string): Promise<unknown> {
    switch (job) {
      case 'audit-partitions':
        return { created: await ensureAuditPartitions(this.db, 3) };
      case 'purge-expired': {
        // Quarantined customer files never sent lose their bytes (W09).
        const uploads = await purgeWidgetUploads(this.db);
        // Website visitors and their page views leave 30 days after they were last seen.
        const visitors = await purgeVisitors(this.db);
        return {
          ...(await purgeExpired(this.db)),
          migration_files: await purgeMigrationFiles(this.db),
          widget_uploads_expired: uploads.expired,
          widget_uploads_removed: uploads.removed,
          visitor_page_views_removed: visitors.pageViews,
          visitor_sessions_removed: visitors.sessions,
          visitors_removed: visitors.visitors,
          // What chat automations did is kept for 90 days (G21).
          automation_runs_removed: await purgeAutomationRuns(this.db),
        };
      }
      case 'reconcile-cursors':
        return { followed: await ensureReconcileCursors(this.db) };
      case 'memory-retention':
        return { deleted: await this.memory.purgeExpired() };
      case 'memory-tombstones':
        return { removed: await this.memory.replayTombstones() };
      case 'webhook-retention':
        return purgeWebhookEvents(this.db, { keepDays: this.config.WEBHOOK_LOG_DAYS });
      default:
        throw new Error(`Unknown maintenance job ${job}`);
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    this.queue = new Queue(QUEUE, { connection: this.redis, prefix: 'hamnivo' });
    await this.queue.upsertJobScheduler(
      'audit-partitions',
      { every: 24 * 60 * 60 * 1000 },
      { name: 'audit-partitions' },
    );
    await this.queue.upsertJobScheduler(
      'purge-expired',
      { every: 10 * 60 * 1000 },
      { name: 'purge-expired' },
    );
    // Safety net: conversations are followed from their start; this catches any that are not.
    await this.queue.upsertJobScheduler(
      'reconcile-cursors',
      { every: 10 * 60 * 1000 },
      { name: 'reconcile-cursors' },
    );
    await this.queue.upsertJobScheduler(
      'memory-retention',
      { every: 60 * 60 * 1000 },
      { name: 'memory-retention' },
    );
    await this.queue.upsertJobScheduler(
      'memory-tombstones',
      { every: 24 * 60 * 60 * 1000 },
      { name: 'memory-tombstones' },
    );
    await this.queue.upsertJobScheduler(
      'webhook-retention',
      { every: 60 * 60 * 1000 },
      { name: 'webhook-retention' },
    );
    this.worker = new Worker(QUEUE, (job) => this.run(job.name), {
      connection: this.redis.duplicate(),
      prefix: 'hamnivo',
      concurrency: 1,
    });
    this.worker.on('failed', (job, error) =>
      this.logger.error(`maintenance ${job?.name} failed: ${error.message}`),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}
