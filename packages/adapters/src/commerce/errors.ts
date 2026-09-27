/**
 * Provider failures, classified by what they mean for money. `mayHaveApplied` is the question
 * that matters after a failed write: a refused request (4xx) did nothing, but a timeout, a reset
 * connection or a server error may have been applied, so the operation becomes `unknown` and is
 * resolved from the provider, never by writing again blindly (C07, C09).
 */
export type CommerceErrorKind =
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'unavailable'
  | 'auth'
  | 'invalid_request'
  | 'not_found'
  | 'idempotency_conflict'
  | 'card_declined'
  | 'unsupported'
  | 'unknown';

export class CommerceProviderError extends Error {
  override name = 'CommerceProviderError';
  constructor(
    readonly kind: CommerceErrorKind,
    message: string,
    readonly options: {
      retryable: boolean;
      mayHaveApplied: boolean;
      status?: number;
      /** Provider error code (e.g. `resource_missing`), never the provider's free text. */
      code?: string | null;
    },
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.options.retryable;
  }

  get mayHaveApplied(): boolean {
    return this.options.mayHaveApplied;
  }
}

export class WebhookSignatureError extends Error {
  override name = 'WebhookSignatureError';
  constructor(readonly reason: 'missing' | 'mismatch' | 'stale' | 'malformed') {
    super(`Webhook signature ${reason}`);
  }
}

/** The quote cannot be built as asked (unknown product, inactive price, mixed currencies…). */
export class QuoteRejectedError extends Error {
  override name = 'QuoteRejectedError';
  constructor(
    readonly reason:
      | 'unknown_product'
      | 'inactive_product'
      | 'out_of_stock'
      | 'currency_mismatch'
      | 'currency_not_supported'
      | 'amount_not_representable'
      | 'recurring_not_supported',
    readonly productId?: string,
  ) {
    super(`Quote rejected: ${reason}${productId ? ` (${productId})` : ''}`);
  }
}
