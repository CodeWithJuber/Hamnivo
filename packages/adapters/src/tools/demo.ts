import { createHash, randomBytes } from 'node:crypto';

/**
 * `demo`: an in-memory order-service stand-in for the demo tools (change a delivery address,
 * issue a store credit), for development, demos and tests. Like a real service it honours
 * idempotency keys (the same key never applies twice), answers lookups by key so a lost answer can
 * be reconciled, and can be told to fail a call before or after applying it, or to be slow. Each
 * process keeps its own stores; the gateway proposes, executes and reconciles demo actions in the
 * worker process.
 */

export type DemoFault = 'timeout_before' | 'timeout_after' | 'unavailable';
export type DemoOperation = 'updateAddress' | 'issueCredit';

/** A failed demo call; `mayHaveApplied` follows the same rule as real providers. */
export class DemoToolError extends Error {
  override readonly name = 'DemoToolError';
  constructor(
    readonly kind: 'timeout' | 'unavailable' | 'not_found' | 'aborted',
    message: string,
    readonly mayHaveApplied: boolean,
  ) {
    super(message);
  }
}

export interface DemoAddress {
  reference: string;
  address: string;
  /** Changes on every update: approvals are bound to it. */
  revision: string;
}

export interface DemoAddressChange {
  changeId: string;
  reference: string;
  from: string;
  to: string;
  revision: string;
}

export interface DemoCredit {
  creditId: string;
  reference: string;
  amountMinor: string;
  currency: string;
}

type Applied =
  | { kind: 'address'; result: DemoAddressChange }
  | { kind: 'credit'; result: DemoCredit };

const STREETS = ['Harbour Street', 'Palm Road', 'Cedar Lane', 'Al Noor Street', 'Station Road'];

/** The same reference gets the same starting address in every process (demo data). */
function initialAddress(reference: string): string {
  const digest = createHash('sha256').update(reference).digest();
  const number = ((digest[0] ?? 0) % 90) + 10;
  return `${number} ${STREETS[(digest[1] ?? 0) % STREETS.length]}`;
}

export class DemoActionsStore {
  private static readonly stores = new Map<string, DemoActionsStore>();

  static get(id: string): DemoActionsStore {
    let store = DemoActionsStore.stores.get(id);
    if (!store) {
      store = new DemoActionsStore();
      DemoActionsStore.stores.set(id, store);
    }
    return store;
  }

  static reset(id: string): void {
    DemoActionsStore.stores.delete(id);
  }

  private readonly addresses = new Map<string, { address: string; version: number }>();
  private readonly applied = new Map<string, Applied>();
  /** Faults for the next calls of an operation, used in order. */
  readonly faults = new Map<DemoOperation, DemoFault[]>();
  /** Milliseconds each call of an operation waits before applying (cancellation tests). */
  readonly delays = new Map<DemoOperation, number>();
  /** How many times each idempotency key changed something (always 0 or 1). */
  readonly effects = new Map<string, number>();

  address(reference: string): DemoAddress {
    const stored = this.addresses.get(reference);
    const address = stored?.address ?? initialAddress(reference);
    return { reference, address, revision: `v${stored?.version ?? 1}` };
  }

  /** What a key applied, if anything (reconciliation). */
  lookup(idempotencyKey: string): Applied | null {
    return this.applied.get(idempotencyKey) ?? null;
  }

  private async before(operation: DemoOperation, signal?: AbortSignal): Promise<DemoFault | null> {
    const delay = this.delays.get(operation) ?? 0;
    if (delay > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new DemoToolError('aborted', 'The call was cancelled.', true));
          },
          { once: true },
        );
      });
    }
    signal?.throwIfAborted();
    const fault = this.faults.get(operation)?.shift() ?? null;
    if (fault === 'timeout_before') {
      throw new DemoToolError('timeout', 'The service did not answer in time.', true);
    }
    if (fault === 'unavailable') {
      throw new DemoToolError('unavailable', 'The service is unavailable.', false);
    }
    return fault;
  }

  private after(fault: DemoFault | null) {
    if (fault === 'timeout_after') {
      throw new DemoToolError('timeout', 'The service did not answer in time.', true);
    }
  }

  private record(key: string, applied: Applied) {
    this.applied.set(key, applied);
    this.effects.set(key, (this.effects.get(key) ?? 0) + 1);
  }

  async updateAddress(
    input: { reference: string; address: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<DemoAddressChange> {
    const fault = await this.before('updateAddress', signal);
    const previous = this.applied.get(input.idempotencyKey);
    if (previous?.kind === 'address') {
      this.after(fault);
      return previous.result;
    }
    const current = this.address(input.reference);
    const version = (this.addresses.get(input.reference)?.version ?? 1) + 1;
    this.addresses.set(input.reference, { address: input.address, version });
    const result: DemoAddressChange = {
      changeId: `chg_${randomBytes(6).toString('hex')}`,
      reference: input.reference,
      from: current.address,
      to: input.address,
      revision: `v${version}`,
    };
    this.record(input.idempotencyKey, { kind: 'address', result });
    this.after(fault);
    return result;
  }

  async issueCredit(
    input: { reference: string; amountMinor: string; currency: string; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<DemoCredit> {
    const fault = await this.before('issueCredit', signal);
    const previous = this.applied.get(input.idempotencyKey);
    if (previous?.kind === 'credit') {
      this.after(fault);
      return previous.result;
    }
    const result: DemoCredit = {
      creditId: `cr_${randomBytes(6).toString('hex')}`,
      reference: input.reference,
      amountMinor: input.amountMinor,
      currency: input.currency,
    };
    this.record(input.idempotencyKey, { kind: 'credit', result });
    this.after(fault);
    return result;
  }
}
