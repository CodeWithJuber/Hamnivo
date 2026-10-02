import { currencyOf } from '../commerce/currencies.js';
import { LIMITS, type LimitKey } from './limits.js';
import type { BillingPeriod } from './period.js';

/**
 * Invoices for Hamnivo's own plans (A16): the plan's price for the period, plus metered usage
 * beyond what the plan includes. Amounts are integer minor units (bigint), never floats. Taxes
 * are not calculated here.
 */

export interface MeteredPrice {
  /** A limit counted per period. */
  limit: 'conversations' | 'aiReplies' | 'aiTokens';
  /** Units the plan price already covers. */
  includedUnits: number;
  /** Price of each block of `perUnits` beyond the included units; a started block counts. */
  unitPriceMinor: bigint;
  perUnits: number;
}

export interface PlanPricing {
  key: string;
  name: string;
  currency: string;
  priceMinor: bigint;
  metered: readonly MeteredPrice[];
}

export interface InvoiceLine {
  kind: 'plan' | 'metered';
  limitKey: LimitKey | null;
  /** English description; Studio shows its own translation from the other fields. */
  description: string;
  /** Units used in the period (1 for the plan line). */
  quantity: number;
  includedUnits: number | null;
  billableUnits: number;
  perUnits: number;
  unitPriceMinor: bigint;
  amountMinor: bigint;
}

export interface InvoiceDraft {
  currency: string;
  lines: InvoiceLine[];
  subtotalMinor: bigint;
  totalMinor: bigint;
}

export class InvalidPricingError extends Error {
  override name = 'InvalidPricingError';
}

const UNIT_NAMES: Record<MeteredPrice['limit'], string> = {
  conversations: 'conversations',
  aiReplies: 'AI replies',
  aiTokens: 'AI tokens',
};

/** Checks a plan's prices; throws InvalidPricingError with what is wrong. */
export function validatePricing(plan: PlanPricing): void {
  currencyOf(plan.currency);
  if (plan.priceMinor < 0n) throw new InvalidPricingError('The plan price cannot be negative.');
  const seen = new Set<string>();
  for (const price of plan.metered) {
    if (LIMITS[price.limit]?.kind !== 'period') {
      throw new InvalidPricingError(`${price.limit} is not metered per period.`);
    }
    if (seen.has(price.limit)) throw new InvalidPricingError(`${price.limit} is priced twice.`);
    seen.add(price.limit);
    if (!Number.isSafeInteger(price.includedUnits) || price.includedUnits < 0) {
      throw new InvalidPricingError('Included units must be a whole number, zero or more.');
    }
    if (!Number.isSafeInteger(price.perUnits) || price.perUnits < 1) {
      throw new InvalidPricingError('A price must be per one unit or more.');
    }
    if (price.unitPriceMinor < 0n) throw new InvalidPricingError('A price cannot be negative.');
  }
}

/** The lines and totals of the invoice for one period's usage. */
export function draftInvoice(
  plan: PlanPricing,
  usage: Partial<Record<LimitKey, number>>,
  period: BillingPeriod,
): InvoiceDraft {
  validatePricing(plan);
  const currency = currencyOf(plan.currency);
  const lines: InvoiceLine[] = [
    {
      kind: 'plan',
      limitKey: null,
      description: `${plan.name} plan, ${period.key}`,
      quantity: 1,
      includedUnits: null,
      billableUnits: 1,
      perUnits: 1,
      unitPriceMinor: plan.priceMinor,
      amountMinor: plan.priceMinor,
    },
  ];
  for (const price of plan.metered) {
    const used = Math.max(0, Math.trunc(usage[price.limit] ?? 0));
    const billable = Math.max(0, used - price.includedUnits);
    if (billable === 0) continue;
    const blocks = BigInt(Math.ceil(billable / price.perUnits));
    lines.push({
      kind: 'metered',
      limitKey: price.limit,
      description: `${UNIT_NAMES[price.limit]} beyond the ${price.includedUnits} included`,
      quantity: used,
      includedUnits: price.includedUnits,
      billableUnits: billable,
      perUnits: price.perUnits,
      unitPriceMinor: price.unitPriceMinor,
      amountMinor: blocks * price.unitPriceMinor,
    });
  }
  const subtotal = lines.reduce((sum, line) => sum + line.amountMinor, 0n);
  return { currency, lines, subtotalMinor: subtotal, totalMinor: subtotal };
}

export const INVOICE_STATES = ['draft', 'issued', 'paid', 'void'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

const NEXT: Record<InvoiceState, readonly InvoiceState[]> = {
  draft: ['issued', 'void'],
  issued: ['paid', 'void'],
  paid: [],
  void: [],
};

/** draft → issued → paid, and void from draft or issued. Paid and void are final. */
export function canMoveInvoice(from: InvoiceState, to: InvoiceState): boolean {
  return NEXT[from].includes(to);
}
