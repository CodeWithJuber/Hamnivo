/**
 * Provider capability manifests and negotiation (C01, E02). Each merchant connection declares
 * what its provider can actually do; an operation outside the manifest is refused before any
 * call, with a reason and a recovery path the customer or staff member can follow.
 */
export interface CommerceCapabilities {
  version: 1;
  provider: string;
  /** The provider API version this manifest was checked against. */
  apiVersion: string;
  catalog: { search: boolean; variants: boolean; stock: boolean };
  checkout: { hosted: boolean; authorizationOnly: boolean };
  refunds: { full: boolean; partial: boolean };
  cancellation: boolean;
  recurring: boolean;
  /** Accepting an order starts provisioning at the merchant (a separate permission, C18). */
  provisioning: boolean;
  currencies: string[];
  /** ISO 3166-1 alpha-2 codes; empty means the merchant ships or serves nowhere in particular. */
  countries: string[];
  tax: 'included' | 'exclusive' | 'none';
}

export type CommerceOperation =
  | 'catalog.search'
  | 'quote'
  | 'checkout.hosted'
  | 'checkout.authorize_only'
  | 'refund.full'
  | 'refund.partial'
  | 'order.cancel'
  | 'subscription.start'
  | 'provisioning.accept';

export type UnsupportedReason =
  | 'operation_not_supported'
  | 'currency_not_supported'
  | 'country_not_supported';

/** What the person can do instead; the interface turns each into one plain sentence. */
export type RecoveryPath =
  | 'contact_team'
  | 'full_refund_only'
  | 'choose_supported_currency'
  | 'use_hosted_checkout'
  | 'one_time_purchase_only'
  | 'ask_merchant';

export type Negotiation =
  | { supported: true }
  | { supported: false; reason: UnsupportedReason; recovery: RecoveryPath };

function allowedBy(capabilities: CommerceCapabilities, operation: CommerceOperation): boolean {
  switch (operation) {
    case 'catalog.search':
      return capabilities.catalog.search;
    case 'quote':
      return capabilities.currencies.length > 0;
    case 'checkout.hosted':
      return capabilities.checkout.hosted;
    case 'checkout.authorize_only':
      return capabilities.checkout.authorizationOnly;
    case 'refund.full':
      return capabilities.refunds.full;
    case 'refund.partial':
      return capabilities.refunds.partial;
    case 'order.cancel':
      return capabilities.cancellation;
    case 'subscription.start':
      return capabilities.recurring;
    case 'provisioning.accept':
      return capabilities.provisioning;
  }
}

const RECOVERY: Record<CommerceOperation, RecoveryPath> = {
  'catalog.search': 'ask_merchant',
  quote: 'contact_team',
  'checkout.hosted': 'contact_team',
  'checkout.authorize_only': 'use_hosted_checkout',
  'refund.full': 'contact_team',
  'refund.partial': 'full_refund_only',
  'order.cancel': 'contact_team',
  'subscription.start': 'one_time_purchase_only',
  'provisioning.accept': 'contact_team',
};

export function negotiate(
  capabilities: CommerceCapabilities,
  operation: CommerceOperation,
  context: { currency?: string; country?: string } = {},
): Negotiation {
  if (!allowedBy(capabilities, operation)) {
    const recovery =
      operation === 'refund.partial' && !capabilities.refunds.full
        ? 'contact_team'
        : RECOVERY[operation];
    return { supported: false, reason: 'operation_not_supported', recovery };
  }
  if (context.currency && !capabilities.currencies.includes(context.currency)) {
    return {
      supported: false,
      reason: 'currency_not_supported',
      recovery: 'choose_supported_currency',
    };
  }
  if (
    context.country &&
    capabilities.countries.length > 0 &&
    !capabilities.countries.includes(context.country)
  ) {
    return { supported: false, reason: 'country_not_supported', recovery: 'contact_team' };
  }
  return { supported: true };
}
