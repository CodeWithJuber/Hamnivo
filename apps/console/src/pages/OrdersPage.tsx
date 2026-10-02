import { EmptyState } from '@hamnivo/ui/components/async-states';
import { Button } from '@hamnivo/ui/components/button';
import { Checkbox } from '@hamnivo/ui/components/checkbox';
import { Input } from '@hamnivo/ui/components/input';
import { Label } from '@hamnivo/ui/components/label';
import { StatusBadge, type StatusTone } from '@hamnivo/ui/components/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@hamnivo/ui/components/table';
import { Link } from '@tanstack/react-router';
import { ShoppingBagIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader, Section } from '../components/PageHeader';
import { QueryState } from '../components/States';
import { formatAmount, formatWhen, type OrderSummary, useOrders } from '../lib/commerce';
import { useTenant } from '../lib/tenant';

const PAYMENT_TONE: Record<string, StatusTone> = {
  captured: 'success',
  authorized: 'info',
  processing: 'info',
  requires_action: 'warning',
  not_started: 'neutral',
  failed: 'danger',
  cancelled: 'neutral',
  unknown: 'warning',
};

export function PaymentBadge({ state }: { state: string }) {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={PAYMENT_TONE[state] ?? 'neutral'} data-payment={state}>
      {t(`commerce.payment.${state as 'captured'}`, { defaultValue: state })}
    </StatusBadge>
  );
}

export function FulfilmentText({ state }: { state: string }) {
  const { t } = useTranslation();
  return <>{t(`commerce.fulfilment.${state as 'pending'}`, { defaultValue: state })}</>;
}

function Attention({ order }: { order: OrderSummary }) {
  const { t } = useTranslation();
  if (order.openExceptions === 0 && order.pendingRefunds === 0) return <>—</>;
  return (
    <div className="flex flex-wrap gap-1">
      {order.pendingRefunds > 0 ? (
        <StatusBadge tone="warning">
          {t('commerce.orders.pendingRefunds', { count: order.pendingRefunds })}
        </StatusBadge>
      ) : null}
      {order.openExceptions > 0 ? (
        <StatusBadge tone="danger">
          {t('commerce.orders.openExceptions', { count: order.openExceptions })}
        </StatusBadge>
      ) : null}
    </div>
  );
}

/** Orders placed in chat (C10), newest first, with what needs a person (C19). */
export function OrdersPage() {
  const { t } = useTranslation();
  const { can } = useTenant();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [attention, setAttention] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const orders = useOrders({ q, needsAttention: attention });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('commerce.orders.title')}
        description={t('commerce.orders.description')}
      />
      <Section id="orders" title={t('commerce.orders.title')}>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex min-w-60 flex-col gap-2">
            <Label htmlFor="orders-search">{t('commerce.orders.search')}</Label>
            <Input
              id="orders-search"
              type="search"
              value={text}
              onChange={(event) => setText(event.target.value)}
              dir="ltr"
            />
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Checkbox
              id="orders-attention"
              checked={attention}
              onCheckedChange={(checked) => setAttention(checked === true)}
            />
            <Label htmlFor="orders-attention">{t('commerce.orders.needsAttention')}</Label>
          </div>
        </div>
        <QueryState
          query={orders}
          label={t('commerce.orders.loading')}
          permitted={can('commerce.read')}
          isEmpty={(data) => data.items.length === 0}
          empty={
            <EmptyState
              kind={q || attention ? 'no-matches' : 'no-records'}
              icon={<ShoppingBagIcon className="size-6 text-text-muted" aria-hidden="true" />}
              title={
                q || attention ? t('commerce.orders.emptyFiltered') : t('commerce.orders.empty')
              }
              action={
                q || attention ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setText('');
                      setQ('');
                      setAttention(false);
                    }}
                  >
                    {t('commerce.orders.clearFilters')}
                  </Button>
                ) : (
                  <Button asChild variant="secondary">
                    <Link to="/overview">{t('states.backToOverview')}</Link>
                  </Button>
                )
              }
            />
          }
        >
          {(data) => (
            <Table data-testid="orders-table">
              <TableHeader>
                <TableRow>
                  <TableHead>{t('commerce.orders.columns.reference')}</TableHead>
                  <TableHead>{t('commerce.orders.columns.customer')}</TableHead>
                  <TableHead>{t('commerce.orders.columns.placed')}</TableHead>
                  <TableHead className="text-end">{t('commerce.orders.columns.total')}</TableHead>
                  <TableHead>{t('commerce.orders.columns.payment')}</TableHead>
                  <TableHead>{t('commerce.orders.columns.fulfilment')}</TableHead>
                  <TableHead>{t('commerce.orders.columns.attention')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((order) => (
                  <TableRow key={order.id} data-order={order.reference}>
                    <TableCell>
                      <Link
                        to="/orders/$orderId"
                        params={{ orderId: order.id }}
                        className="font-medium text-link underline underline-offset-2"
                      >
                        <bdi dir="ltr">{order.reference}</bdi>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <bdi>{order.customer.displayName ?? t('commerce.orders.visitor')}</bdi>
                    </TableCell>
                    <TableCell>{formatWhen(order.placedAt)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {formatAmount(order.totalMinor, order.currency)}
                    </TableCell>
                    <TableCell>
                      <PaymentBadge state={order.paymentState} />
                    </TableCell>
                    <TableCell>
                      <FulfilmentText state={order.fulfillmentState} />
                    </TableCell>
                    <TableCell>
                      <Attention order={order} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </QueryState>
      </Section>
    </div>
  );
}
