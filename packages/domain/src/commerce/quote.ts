import { currencyOf } from './currencies.js';
import { canonicalHash } from './hash.js';
import { add, money, multiply, subtract, sum } from './money.js';

/**
 * The quote document: the exact values a customer approves. Everything the approval binds is in
 * here (merchant, lines, amounts, currency, recurrence, delivery, expiry and the cart revision it
 * was made from), and its canonical SHA-256 is the quote hash (C03, C04). The widget renders the
 * card from this document and recomputes the hash before it enables the approval button.
 */
export interface QuoteLineDocument {
  lineId: string;
  productId: string;
  variantId: string | null;
  name: string;
  quantity: number;
  unitPriceMinor: string;
  totalMinor: string;
}

export interface QuoteDocument {
  v: 1;
  quoteId: string;
  merchant: { connectionId: string; name: string };
  cart: { id: string; revision: number };
  currency: string;
  lines: QuoteLineDocument[];
  subtotalMinor: string;
  discountMinor: string;
  /** null: the merchant quoted no separate tax because prices include it (see `taxMode`). */
  taxMinor: string | null;
  taxMode: 'included' | 'exclusive' | 'none';
  shippingMinor: string | null;
  totalMinor: string;
  recurring: { interval: 'week' | 'month' | 'year'; intervalCount: number } | null;
  /** A masked summary only (e.g. "Sara N. · Al Noor Street, Dubai"), never a full address. */
  delivery: string | null;
  expiresAt: string;
}

export class QuoteArithmeticError extends Error {
  override name = 'QuoteArithmeticError';
}

/**
 * Checks that the document adds up exactly: each line is unit × quantity, the subtotal is the sum
 * of lines, and total = subtotal − discount + tax + shipping, all in one currency. A merchant
 * answer that does not add up is refused rather than shown.
 */
export function verifyQuoteArithmetic(doc: QuoteDocument): void {
  const currency = currencyOf(doc.currency);
  if (doc.lines.length === 0) throw new QuoteArithmeticError('A quote needs at least one line');
  for (const line of doc.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new QuoteArithmeticError(`Line ${line.lineId}: quantity must be a positive integer`);
    }
    const expected = multiply(money(line.unitPriceMinor, currency), line.quantity);
    if (expected.amountMinor !== BigInt(line.totalMinor)) {
      throw new QuoteArithmeticError(`Line ${line.lineId}: total is not unit price × quantity`);
    }
    if (BigInt(line.unitPriceMinor) < 0n) {
      throw new QuoteArithmeticError(`Line ${line.lineId}: negative price`);
    }
  }
  const subtotal = sum(
    doc.lines.map((l) => money(l.totalMinor, currency)),
    currency,
  );
  if (subtotal.amountMinor !== BigInt(doc.subtotalMinor)) {
    throw new QuoteArithmeticError('Subtotal is not the sum of the lines');
  }
  const discount = money(doc.discountMinor, currency);
  if (discount.amountMinor < 0n || discount.amountMinor > subtotal.amountMinor) {
    throw new QuoteArithmeticError('Discount is out of range');
  }
  let total = subtract(subtotal, discount);
  if (doc.taxMinor !== null) total = add(total, money(doc.taxMinor, currency));
  if (doc.shippingMinor !== null) total = add(total, money(doc.shippingMinor, currency));
  if (total.amountMinor !== BigInt(doc.totalMinor)) {
    throw new QuoteArithmeticError('Total is not subtotal − discount + tax + shipping');
  }
  if (doc.taxMode === 'exclusive' && doc.taxMinor === null) {
    throw new QuoteArithmeticError('Tax is exclusive but no tax amount was quoted');
  }
}

export function quoteHash(doc: QuoteDocument): string {
  return canonicalHash(doc);
}
