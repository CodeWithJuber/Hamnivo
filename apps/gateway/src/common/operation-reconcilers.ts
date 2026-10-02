import { Injectable } from '@nestjs/common';

type Reconciler = (tenantId: string, operationId: string) => Promise<void>;

/**
 * One operation ledger serves commerce and AI tool actions. The commerce worker leases every
 * operation still owed an outcome and handles its own kinds; other modules register a reconciler
 * for their kind prefix (`tool.`), so an unknown outcome is always checked, never resent.
 */
@Injectable()
export class OperationReconcilers {
  private readonly handlers = new Map<string, Reconciler>();

  register(prefix: string, handler: Reconciler): void {
    this.handlers.set(prefix, handler);
  }

  /** Runs the reconciler for this kind; false when no module claims it. */
  async reconcile(kind: string, tenantId: string, operationId: string): Promise<boolean> {
    for (const [prefix, handler] of this.handlers) {
      if (kind.startsWith(prefix)) {
        await handler(tenantId, operationId);
        return true;
      }
    }
    return false;
  }
}
