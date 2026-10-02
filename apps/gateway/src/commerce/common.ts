import { createHash } from 'node:crypto';
import { CommerceProviderError, QuoteRejectedError } from '@hamnivo/adapters/commerce';
import { canonicalJson, money, toMajorString } from '@hamnivo/domain/commerce';
import { AppError } from '../common/app-error.js';

/** Who started a commerce change: kept on operations, snapshots and audit events. */
export interface CommerceActor {
  type: 'customer' | 'staff' | 'ai' | 'system';
  /** Public id (cus_…, stf_…) or a fixed name such as `worker`. */
  id: string | null;
}

export const SYSTEM_ACTOR: CommerceActor = { type: 'system', id: 'commerce' };

/** SHA-256 of the canonical JSON of a value (request hashes, card hashes). */
export function canonicalDigest(value: unknown): Buffer {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest();
}

export const sha256Hex = (value: unknown): string => canonicalDigest(value).toString('hex');

/** "AED 95.00": amounts in plain-text fallbacks and notes (cards format per locale themselves). */
export function moneyText(amountMinor: bigint, currency: string): string {
  return `${currency} ${toMajorString(money(amountMinor, currency))}`;
}

/** Exponential backoff for provider checks: 30 s doubling up to `capMs`. */
export function backoffMs(attempt: number, capMs = 30 * 60_000): number {
  return Math.min(capMs, 30_000 * 2 ** Math.max(0, attempt - 1));
}

/** Provider failures as public errors: nothing about the provider's own wording leaks. */
export function providerProblem(error: unknown, detail?: string): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof QuoteRejectedError) {
    const reasons: Record<QuoteRejectedError['reason'], string> = {
      unknown_product: 'This product is no longer sold.',
      inactive_product: 'This product is not available right now.',
      out_of_stock: 'This product is out of stock.',
      currency_mismatch: 'This product is sold in another currency.',
      currency_not_supported: 'The shop does not sell in this currency.',
      amount_not_representable: 'This amount cannot be charged by the payment provider.',
      recurring_not_supported: 'Subscriptions cannot be bought in chat yet.',
    };
    return new AppError('VALIDATION_FAILED', {
      detail: reasons[error.reason],
      fields: [
        {
          path: error.productId ? `lines.${error.productId}` : 'lines',
          message: reasons[error.reason],
        },
      ],
      internal: { reason: error.reason },
    });
  }
  if (error instanceof CommerceProviderError) {
    return new AppError('PROVIDER_UNAVAILABLE', {
      detail: detail ?? 'The shop could not be reached. Please try again in a moment.',
      retryable: error.retryable,
      ...(error.retryable ? { retryAfter: 5 } : {}),
      internal: { kind: error.kind, status: error.options.status, code: error.options.code },
    });
  }
  return new AppError('PROVIDER_UNAVAILABLE', {
    detail: detail ?? 'The shop could not be reached. Please try again in a moment.',
    retryAfter: 5,
    internal: error instanceof Error ? error.name : 'unknown',
  });
}

/** Provider error facts safe to store as evidence (never messages, keys or customer data). */
export function errorEvidence(error: unknown): Record<string, unknown> {
  if (error instanceof CommerceProviderError) {
    return {
      kind: error.kind,
      status: error.options.status ?? null,
      code: error.options.code ?? null,
      mayHaveApplied: error.mayHaveApplied,
    };
  }
  return { kind: 'unexpected', name: error instanceof Error ? error.name : typeof error };
}

export function errorCode(error: unknown): string {
  if (error instanceof CommerceProviderError) return error.options.code ?? error.kind;
  return 'unexpected';
}

/** A provider write whose outcome is not known: it may have been applied. */
export const outcomeUnknown = (error: unknown) =>
  !(error instanceof CommerceProviderError) || error.mayHaveApplied;

export const minor = (value: bigint): string => value.toString();
