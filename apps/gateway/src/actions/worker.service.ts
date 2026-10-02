import type { ClaimedOutboxEvent } from '@hamnivo/db';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ActionApprovals } from './approvals.service.js';
import { ActionExecutor } from './executor.service.js';

const EVERY_MS = 30_000;

/**
 * The actions worker: expires approvals nobody decided in time, and runs staff "Check status"
 * requests where tools run. Sending approved actions and reconciling lost answers are driven by
 * the outbox and the operation ledger's worker.
 */
@Injectable()
export class ActionsWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ActionsWorker.name);
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly approvals: ActionApprovals,
    private readonly executor: ActionExecutor,
  ) {}

  onApplicationBootstrap(): void {
    this.stopped = false;
    this.schedule();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.loop;
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.loop = this.drainOnce()
        .then(() => undefined)
        .catch((error: unknown) => this.logger.warn(`actions upkeep failed: ${String(error)}`))
        .finally(() => {
          this.loop = undefined;
          this.schedule();
        });
    }, EVERY_MS);
  }

  /** One pass; returns how many approvals expired. */
  async drainOnce(): Promise<number> {
    return this.approvals.expireOverdue();
  }

  /** Outbox `action.reconcile`: a person asked to check an action's outcome. */
  async onReconcile(event: ClaimedOutboxEvent): Promise<void> {
    const payload = event.payload as { operationId: string };
    await this.executor.reconcileOperation(event.tenantId, payload.operationId, 'staff');
  }
}
