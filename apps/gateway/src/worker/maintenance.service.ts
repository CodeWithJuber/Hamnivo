import { type Db, ensureAuditPartitions, ensureReconcileCursors, purgeExpired } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_DB, REDIS } from '../tokens.js';

const QUEUE = 'hamnivo-maintenance';

/**
 * Scheduled upkeep through BullMQ job schedulers: audit partitions daily; expiry purge and
 * reconciler cursors every ten minutes.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceService.name);
  private queue: Queue | undefined;
  private worker: Worker | undefined;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async run(job: string): Promise<unknown> {
    switch (job) {
      case 'audit-partitions':
        return { created: await ensureAuditPartitions(this.db, 3) };
      case 'purge-expired':
        return purgeExpired(this.db);
      case 'reconcile-cursors':
        return { followed: await ensureReconcileCursors(this.db) };
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
