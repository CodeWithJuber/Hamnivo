import type { CheckoutSession, NormalizedEvent, ProviderRefund } from '@hamnivo/adapters/commerce';

/**
 * Verified provider events are stored in their normalized form only (no customer details, no
 * payment method data). These functions turn them into JSON and back, keeping exact amounts.
 */

type Json = Record<string, unknown>;

const bigintText = (value: bigint | null) => (value === null ? null : value.toString());
const dateText = (value: Date) => value.toISOString();

function sessionJson(session: CheckoutSession): Json {
  return {
    ...session,
    amountTotalMinor: bigintText(session.amountTotalMinor),
    createdAt: dateText(session.createdAt),
    expiresAt: dateText(session.expiresAt),
  };
}

function refundJson(refund: ProviderRefund): Json {
  return {
    ...refund,
    amountMinor: refund.amountMinor.toString(),
    createdAt: dateText(refund.createdAt),
  };
}

export function eventToJson(event: NormalizedEvent): Json {
  return {
    id: event.id,
    type: event.type,
    providerType: event.providerType,
    occurredAt: dateText(event.occurredAt),
    account: event.account,
    livemode: event.livemode,
    ...(event.checkout ? { checkout: sessionJson(event.checkout) } : {}),
    ...(event.refund ? { refund: refundJson(event.refund) } : {}),
    ...(event.paymentRef !== undefined ? { paymentRef: event.paymentRef } : {}),
    ...(event.reference !== undefined ? { reference: event.reference } : {}),
  };
}

export function eventFromJson(json: Json): NormalizedEvent {
  const checkout = json.checkout as Json | undefined;
  const refund = json.refund as Json | undefined;
  return {
    id: String(json.id),
    type: json.type as NormalizedEvent['type'],
    providerType: String(json.providerType),
    occurredAt: new Date(String(json.occurredAt)),
    account: (json.account as string | null) ?? null,
    livemode: json.livemode === true,
    ...(checkout
      ? {
          checkout: {
            ...(checkout as unknown as CheckoutSession),
            amountTotalMinor:
              checkout.amountTotalMinor === null ? null : BigInt(String(checkout.amountTotalMinor)),
            createdAt: new Date(String(checkout.createdAt)),
            expiresAt: new Date(String(checkout.expiresAt)),
          },
        }
      : {}),
    ...(refund
      ? {
          refund: {
            ...(refund as unknown as ProviderRefund),
            amountMinor: BigInt(String(refund.amountMinor)),
            createdAt: new Date(String(refund.createdAt)),
          },
        }
      : {}),
    ...('paymentRef' in json ? { paymentRef: (json.paymentRef as string | null) ?? null } : {}),
    ...('reference' in json ? { reference: (json.reference as string | null) ?? null } : {}),
  };
}
