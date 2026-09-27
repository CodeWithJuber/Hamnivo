import type {
  FinanceExceptionView,
  OrderDetail,
  OrderSummary,
  RefundView,
} from '@hamnivo/contracts';
import { formatDateTime, formatMoney, money } from '@hamnivo/domain/commerce';
import i18next from 'i18next';
import { api, newIdempotencyKey } from './api';
import { useStudioMutation, useStudioQuery } from './queries';
import { useTenant } from './tenant';
import type { Items } from './types';

export type { FinanceExceptionView, OrderDetail, OrderSummary, RefundView };

/** Orders, refunds and finance exceptions are live records: never cached, reloaded on focus. */
export const commerceKeys = {
  orders: ['commerce', 'orders'],
  order: (id: string) => ['commerce', 'orders', id],
  exceptions: (state: string) => ['commerce', 'exceptions', state],
} as const;

const locale = () => i18next.resolvedLanguage ?? i18next.language ?? 'en';

/** Exact minor units in the interface language (U06); the currency is always shown. */
export function formatAmount(amountMinor: string | null | undefined, currency: string): string {
  if (amountMinor === null || amountMinor === undefined) return '—';
  try {
    return formatMoney(money(BigInt(amountMinor), currency), locale());
  } catch {
    return `${currency} ${amountMinor}`;
  }
}

/** A time with its zone, in the interface language. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatDateTime(new Date(iso), locale(), {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

/** A calendar date the shop gave (a delivery estimate): the same day wherever it is read. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatDateTime(new Date(iso), locale(), { timeZone: 'UTC', part: 'date' });
}

export function useOrders(filter: { q?: string; needsAttention?: boolean }) {
  const { can } = useTenant();
  const query = new URLSearchParams({ limit: '100' });
  if (filter.q) query.set('q', filter.q);
  if (filter.needsAttention) query.set('needsAttention', 'true');
  return useStudioQuery<Items<OrderSummary>>(
    [...commerceKeys.orders, filter.q ?? '', Boolean(filter.needsAttention)],
    `/v1/admin/commerce/orders?${query}`,
    { enabled: can('commerce.read'), refetchInterval: 30_000 },
  );
}

export function useOrder(orderId: string) {
  return useStudioQuery<OrderDetail>(
    commerceKeys.order(orderId),
    `/v1/admin/commerce/orders/${orderId}`,
    {
      // Keep checking while a refund or payment still waits for the provider.
      refetchInterval: (data) =>
        data?.refunds.some((r) => ['submitted', 'pending', 'unknown'].includes(r.state)) ||
        data?.operations.some((o) => ['dispatched', 'unknown'].includes(o.state))
          ? 5_000
          : false,
    },
  );
}

export function useFinanceExceptions(state: 'open' | 'resolved') {
  const { can } = useTenant();
  return useStudioQuery<Items<FinanceExceptionView>>(
    commerceKeys.exceptions(state),
    `/v1/admin/commerce/exceptions?state=${state}`,
    { enabled: can('commerce.read'), refetchInterval: 30_000 },
  );
}

export interface RefundInput {
  amountMinor: string;
  reason: RefundView['reason'];
  note?: string;
  clientRequestId?: string;
}

export function useRequestRefund(orderId: string) {
  return useStudioMutation(
    (input: RefundInput, tenant: string) =>
      api<RefundView>(`/v1/admin/commerce/orders/${orderId}/refunds`, {
        method: 'POST',
        tenant,
        body: {
          clientRequestId: input.clientRequestId ?? newIdempotencyKey(),
          amountMinor: input.amountMinor,
          reason: input.reason,
          ...(input.note ? { note: input.note } : {}),
        },
      }),
    [commerceKeys.orders],
  );
}

export function useRefundDecision(orderId: string) {
  return useStudioMutation(
    (
      input: { refundId: string; decision: 'approve' | 'reject' | 'refresh'; reason?: string },
      tenant: string,
    ) =>
      api<RefundView>(`/v1/admin/commerce/refunds/${input.refundId}/${input.decision}`, {
        method: 'POST',
        tenant,
        body: input.decision === 'reject' ? { reason: input.reason } : {},
      }),
    [commerceKeys.orders, commerceKeys.order(orderId)],
  );
}

export interface FulfilmentInput {
  kind: 'shipment' | 'service';
  state: 'in_progress' | 'delayed' | 'shipped' | 'delivered' | 'provisioned' | 'failed';
  estimateAt?: string;
  carrierRef?: string;
  note?: string;
}

/** Records what the shop reported (C10, HNV-21-02); the customer sees it in the chat. */
export function useRecordFulfilment(orderId: string) {
  return useStudioMutation(
    (input: FulfilmentInput, tenant: string) =>
      api<OrderDetail>(`/v1/admin/commerce/orders/${orderId}/fulfillments`, {
        method: 'POST',
        tenant,
        body: input,
      }),
    [commerceKeys.orders, commerceKeys.order(orderId)],
  );
}

export function useExceptionAction() {
  return useStudioMutation(
    (
      input:
        | { exceptionId: string; action: 'check' }
        | { exceptionId: string; action: 'resolve'; resolution: string; note: string },
      tenant: string,
    ) =>
      api<FinanceExceptionView>(
        `/v1/admin/commerce/exceptions/${input.exceptionId}/${input.action}`,
        {
          method: 'POST',
          tenant,
          body:
            input.action === 'resolve' ? { resolution: input.resolution, note: input.note } : {},
        },
      ),
    [
      ['commerce', 'exceptions'],
      ['commerce', 'orders'],
    ],
  );
}
