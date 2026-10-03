import { type Db, dueWebSyncs } from '@hamnivo/db';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_DB, CLOCK, type Clock } from '../../tokens.js';
import { WebSyncService } from './sync.service.js';

const EVERY_MS = 10_000;
/** Websites started per pass; a pass lasts until the last of them has been read. */
const PER_PASS = 3;

/**
 * Reads the websites that are due: those on a schedule whose time has come, those someone asked
 * to read now, and those a worker left unfinished. It runs beside the outbox relay, never inside
 * it, so a slow site cannot hold up replies or ingestion. A pass finds the due websites across
 * tenants; each read then claims its website inside its own tenant, so two workers never read the
 * same one.
 */
@Injectable()
export class WebSyncWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WebSyncWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;
  private stopped = true;

  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly sync: WebSyncService,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule();
  }

  /** Stops the passes that run on their own (a test drives them by hand with `drainOnce`). */
  async pause(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
  }

  async onApplicationShutdown(): Promise<void> {
    // The read in progress ends at its next page and keeps what it has read.
    this.sync.halt();
    await this.pause();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.drainOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.warn(`website reading failed: ${String(error)}`))
        .finally(() => {
          this.loop = undefined;
          this.schedule();
        });
    }, EVERY_MS);
  }

  /** One pass; returns how many websites were read. */
  async drainOnce(): Promise<number> {
    const due = await dueWebSyncs(this.db, PER_PASS, this.clock());
    let read = 0;
    for (const item of due) {
      if (await this.sync.run(item.tenantId, item.id)) read += 1;
    }
    return read;
  }
}
