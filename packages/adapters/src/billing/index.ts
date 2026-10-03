/**
 * Collecting payment for Hamnivo's own invoices to its tenants (A16). This is platform billing,
 * separate from the payments merchants take from their customers (commerce). A payment
 * provider's invoicing API would implement this port; none is connected yet, so the platform
 * operator records payments by hand and `manualCollection` sends nothing anywhere.
 */

export interface InvoiceForCollection {
  /** Invoice id (`invc_…`), stable across retries: implementations use it as idempotency key. */
  id: string;
  number: string;
  tenantId: string;
  currency: string;
  totalMinor: bigint;
  dueAt: Date;
}

export type CollectionOutcome =
  /** Nothing was sent: the operator records the payment when it arrives. */
  | { status: 'manual' }
  /** The provider accepted the request; its confirmation comes later. */
  | { status: 'pending'; providerRef: string }
  | { status: 'paid'; providerRef: string; paidAt: Date }
  | { status: 'failed'; reason: string; retryAt: Date | null };

export interface InvoicePaymentPort {
  readonly name: string;
  /** Asks the provider to collect an issued invoice. Safe to call again for the same invoice. */
  collect(invoice: InvoiceForCollection): Promise<CollectionOutcome>;
}

/** The default: no provider. Issued invoices wait for a payment recorded by the operator. */
export const manualCollection: InvoicePaymentPort = {
  name: 'manual',
  async collect() {
    return { status: 'manual' };
  },
};

/** A scripted port for tests: returns the queued outcomes in order and records every call. */
export class ScriptedCollection implements InvoicePaymentPort {
  readonly name = 'scripted';
  readonly calls: InvoiceForCollection[] = [];
  constructor(private readonly outcomes: CollectionOutcome[] = []) {}

  async collect(invoice: InvoiceForCollection): Promise<CollectionOutcome> {
    this.calls.push(invoice);
    return this.outcomes.shift() ?? { status: 'manual' };
  }
}
