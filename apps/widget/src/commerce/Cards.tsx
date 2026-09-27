import type { Card, MessagePart } from '@hamnivo/contracts';
import { Button } from '@hamnivo/ui/components/button';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { day, price, time } from './format.js';
import type { Commerce } from './useCommerce.js';

export type Part = Extract<MessagePart, { type: 'card' }>;
type CatalogCard = Extract<Card, { kind: 'catalog' }>;
type QuoteCard = Extract<Card, { kind: 'quote' }>;
type ReceiptCard = Extract<Card, { kind: 'receipt' }>;
type OrderStatusCard = Extract<Card, { kind: 'order_status' }>;

const box = 'w-full max-w-[92%] rounded-2xl border border-border bg-surface p-3 text-sm text-text';

/** A card shown in the conversation, rendered from Hamnivo's record (never from model text). */
export function CommerceCard(props: {
  part: Part;
  commerce: Commerce;
  locale: string;
  /** Asks for a person; absent when a person already has the conversation. */
  onHelp?: (() => void) | undefined;
}) {
  const { card } = props.part;
  switch (card.kind) {
    case 'catalog':
      return <Catalog card={card} commerce={props.commerce} locale={props.locale} />;
    case 'quote':
      return <Quote card={card} commerce={props.commerce} locale={props.locale} />;
    case 'receipt':
      return <Receipt card={card} locale={props.locale} />;
    case 'order_status':
      return <OrderStatus card={card} locale={props.locale} onHelp={props.onHelp} />;
    default:
      return (
        <p dir="auto" className="text-sm text-text-muted">
          {props.part.fallbackText}
        </p>
      );
  }
}

function Catalog(props: { card: CatalogCard; commerce: Commerce; locale: string }) {
  const { t } = useTranslation();
  const { card, commerce, locale } = props;
  const inCart = (productId: string, variantId: string | null) =>
    commerce.cart?.lines.find((l) => l.productId === productId && l.variantId === variantId)
      ?.quantity ?? 0;
  const open = commerce.cart === null || commerce.cart.status === 'open';
  return (
    <section
      className={box}
      aria-label={t('shop.productsFrom', { merchant: card.merchant.name })}
      data-card="catalog"
    >
      <h2 className="mb-2 font-semibold" dir="auto">
        {t('shop.productsFrom', { merchant: card.merchant.name })}
      </h2>
      {card.items.length === 0 ? <p>{t('shop.noProducts')}</p> : null}
      <ul className="flex flex-col gap-3">
        {card.items.map((item) => {
          const count = inCart(item.productId, item.variantId);
          const unavailable = item.availability === 'out_of_stock';
          return (
            <li
              key={`${item.productId}:${item.variantId ?? ''}`}
              className="flex items-start gap-3"
              data-product={item.productId}
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium" dir="auto">
                  {item.name}
                </p>
                {item.description ? (
                  <p className="text-xs text-text-muted" dir="auto">
                    {item.description}
                  </p>
                ) : null}
                <p className="mt-1">
                  <span className="font-medium">
                    {price(item.unitPriceMinor, item.currency, locale)}
                  </span>
                  <span className="ms-2 text-xs text-text-muted">
                    {unavailable
                      ? t('shop.outOfStock')
                      : item.availability === 'in_stock'
                        ? t('shop.inStock')
                        : t('shop.stockUnknown')}
                  </span>
                </p>
              </div>
              {count > 0 ? (
                <fieldset className="m-0 flex items-center gap-1 border-0 p-0">
                  <legend className="sr-only">{item.name}</legend>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('shop.less', { name: item.name })}
                    disabled={!open || commerce.busy !== null}
                    onClick={() => void commerce.setQuantity(card, item, count - 1)}
                  >
                    −
                  </Button>
                  <span className="min-w-6 text-center" aria-live="polite">
                    {t('shop.inCart', { count })}
                  </span>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={t('shop.more', { name: item.name })}
                    disabled={!open || unavailable || commerce.busy !== null}
                    onClick={() => void commerce.setQuantity(card, item, count + 1)}
                  >
                    +
                  </Button>
                </fieldset>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={t('shop.addNamed', { name: item.name })}
                  disabled={!open || unavailable || commerce.busy !== null}
                  onClick={() => void commerce.setQuantity(card, item, 1)}
                >
                  {t('shop.add')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-text-muted" dir="auto">
        {t('shop.pricesChecked', { time: time(card.observedAt, locale) })}
      </p>
    </section>
  );
}

/** Seconds until an ISO time, re-rendering when it passes (an expired quote cannot be approved). */
function useExpired(expiresAt: string): boolean {
  const [expired, setExpired] = useState(() => Date.parse(expiresAt) <= Date.now());
  useEffect(() => {
    const left = Date.parse(expiresAt) - Date.now();
    if (left <= 0) {
      setExpired(true);
      return;
    }
    setExpired(false);
    const timer = setTimeout(() => setExpired(true), Math.min(left, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  return expired;
}

function Quote(props: { card: QuoteCard; commerce: Commerce; locale: string }) {
  const { t } = useTranslation();
  const { card, commerce, locale } = props;
  const live = commerce.quotes[card.quoteId];
  const { ensureQuote } = commerce;
  useEffect(() => {
    void ensureQuote(card.quoteId);
  }, [card.quoteId, ensureQuote]);
  const expired = useExpired(card.expiresAt);
  const status = expired && live?.status === 'ready' ? 'expired' : (live?.status ?? 'ready');
  const purchase = live?.intent ?? null;
  const verified = live ? commerce.verified(live, card.quoteHash) : false;
  const approvable =
    live !== undefined &&
    status === 'ready' &&
    !expired &&
    verified &&
    purchase?.outcome === 'awaiting_approval';
  const money = (value: string | null) => price(value, card.currency, locale);
  const busy = commerce.busy;
  const statusLine = (() => {
    if (!purchase || purchase.outcome === 'awaiting_approval') {
      if (status === 'expired' || expired) return t('shop.expired');
      if (status === 'superseded') return t('shop.superseded');
      if (status === 'cancelled') return t('shop.cancelled');
      if (live && !verified) return t('shop.verifyFailed');
      return t('shop.validUntil', { time: time(card.expiresAt, locale) });
    }
    switch (purchase.outcome) {
      case 'preparing_checkout':
        return t('shop.preparing');
      case 'awaiting_payment':
        return t('shop.awaitingPayment');
      case 'confirming':
        return t('shop.confirming');
      case 'paid':
        return t('shop.paid');
      case 'failed':
        return t('shop.failed');
      case 'expired':
        return t('shop.pageExpired');
      case 'cancelled':
        return t('shop.cancelled');
      case 'needs_human':
        return t('shop.needsHuman');
      default:
        return '';
    }
  })();
  const again =
    (purchase && ['failed', 'expired', 'cancelled'].includes(purchase.outcome)) ||
    (!purchase?.outcome || purchase.outcome === 'awaiting_approval'
      ? status === 'expired' || status === 'superseded'
      : false);
  return (
    <section
      className={box}
      aria-label={t('shop.quoteTitle', { merchant: card.merchant.name })}
      data-card="quote"
      data-status={purchase?.outcome ?? status}
    >
      <h2 className="mb-2 font-semibold" dir="auto">
        {t('shop.quoteTitle', { merchant: card.merchant.name })}
      </h2>
      <table className="w-full text-sm">
        <caption className="sr-only">
          {t('shop.quoteTitle', { merchant: card.merchant.name })}
        </caption>
        <tbody>
          {card.lines.map((line) => (
            <tr key={line.lineId}>
              <th scope="row" className="py-0.5 text-start font-normal" dir="auto">
                {line.quantity} × {line.name}
              </th>
              <td className="py-0.5 text-end tabular-nums">{money(line.totalMinor)}</td>
            </tr>
          ))}
          {card.discountMinor !== '0' ? (
            <tr>
              <th scope="row" className="text-start font-normal">
                {t('shop.discount')}
              </th>
              <td className="text-end tabular-nums">−{money(card.discountMinor)}</td>
            </tr>
          ) : null}
          {card.shippingMinor !== null ? (
            <tr>
              <th scope="row" className="text-start font-normal">
                {t('shop.delivery')}
              </th>
              <td className="text-end tabular-nums">{money(card.shippingMinor)}</td>
            </tr>
          ) : null}
          {card.taxMinor !== null ? (
            <tr>
              <th scope="row" className="text-start font-normal">
                {t('shop.tax')}
              </th>
              <td className="text-end tabular-nums">{money(card.taxMinor)}</td>
            </tr>
          ) : null}
          <tr className="border-t border-border font-semibold">
            <th scope="row" className="pt-1 text-start">
              {t('shop.total')}
            </th>
            <td className="pt-1 text-end tabular-nums" data-testid="quote-total">
              {money(card.totalMinor)}
            </td>
          </tr>
        </tbody>
      </table>
      {card.taxMinor === null ? (
        <p className="mt-1 text-xs text-text-muted">{t('shop.taxIncluded')}</p>
      ) : null}
      <p className="mt-2 text-xs text-text-muted" dir="auto">
        {t('shop.seller', { merchant: card.merchant.name })} · {t('shop.hostedNote')}
      </p>
      {live?.transparency.refundSummary ? (
        <p className="mt-1 text-xs text-text-muted" dir="auto">
          {t('shop.refunds', { summary: live.transparency.refundSummary })}
        </p>
      ) : null}
      {live?.transparency.termsUrl ? (
        <a
          className="mt-1 inline-block text-xs text-link underline"
          href={live.transparency.termsUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('shop.terms')}
        </a>
      ) : null}
      <p className="mt-2" role="status" data-testid="quote-status">
        {statusLine}
        {purchase?.order ? ` ${t('shop.orderRef', { reference: purchase.order.reference })}` : ''}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {!purchase || purchase.outcome === 'awaiting_approval' ? (
          <Button
            size="lg"
            className="w-full"
            disabled={!approvable || busy !== null}
            onClick={() => live && void commerce.approve(live)}
          >
            {busy === `approve:${card.quoteId}` ? t('shop.approving') : t('shop.approve')}
          </Button>
        ) : null}
        {purchase?.outcome === 'awaiting_payment' && purchase.checkout?.url ? (
          <a
            href={purchase.checkout.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground"
          >
            {t('shop.payNow')}
          </a>
        ) : null}
        {purchase &&
        ['preparing_checkout', 'awaiting_payment', 'confirming'].includes(purchase.outcome) ? (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void commerce.checkStatus(card.quoteId, purchase.id)}
          >
            {t('shop.checkStatus')}
          </Button>
        ) : null}
        {purchase?.outcome === 'awaiting_payment' ? (
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => void commerce.cancel(card.quoteId, purchase.id)}
          >
            {t('shop.cancelPayment')}
          </Button>
        ) : null}
        {again && commerce.cart?.status === 'open' ? (
          <Button
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void commerce.review()}
          >
            {t('shop.reviewAgain')}
          </Button>
        ) : null}
      </div>
      {purchase?.outcome === 'awaiting_payment' ? (
        <p className="mt-1 text-xs text-text-muted">{t('shop.payNote')}</p>
      ) : null}
    </section>
  );
}

function Receipt(props: { card: ReceiptCard; locale: string }) {
  const { t } = useTranslation();
  const { card } = props;
  const refund = card.actionId.startsWith('rfd_');
  const text =
    card.outcome === 'completed'
      ? refund
        ? t('shop.receiptRefunded', { reference: card.reference ?? '' })
        : t('shop.receiptPaid', { reference: card.reference ?? '' })
      : card.outcome === 'failed'
        ? t('shop.receiptFailed')
        : card.outcome === 'cancelled'
          ? t('shop.receiptCancelled')
          : t('shop.confirming');
  return (
    <section
      className={box}
      data-card="receipt"
      data-outcome={card.outcome}
      aria-label={t('shop.receipt')}
    >
      <h2 className="font-semibold">{t('shop.receipt')}</h2>
      <p className="mt-1" dir="auto">
        {text}
      </p>
      <p className="mt-1 text-xs text-text-muted">{time(card.occurredAt, props.locale)}</p>
    </section>
  );
}

/** Where an order is (HNV-21-02): the milestone, the shop's estimate, when, and who can help. */
function OrderStatus(props: { card: OrderStatusCard; locale: string; onHelp?: () => void }) {
  const { t } = useTranslation();
  const { card } = props;
  const troubled = card.fulfillmentState === 'delayed' || card.fulfillmentState === 'failed';
  return (
    <section
      className={box}
      data-card="order_status"
      data-status={card.fulfillmentState}
      aria-label={t('shop.orderRef', { reference: card.reference })}
    >
      <h2 className="font-semibold">{t('shop.orderRef', { reference: card.reference })}</h2>
      <p className="mt-1 font-medium" data-testid="order-milestone">
        {t(`shop.fulfillment.${card.fulfillmentState}`)}
      </p>
      {card.estimateAt ? (
        <p className="mt-1" data-testid="order-estimate">
          {t('shop.estimateDate', { date: day(card.estimateAt, props.locale) })}
        </p>
      ) : card.fulfillmentState === 'delayed' ? (
        <p className="mt-1" data-testid="order-estimate">
          {t('shop.noEstimate')}
        </p>
      ) : null}
      <p className="mt-1 text-xs text-text-muted">
        {t('shop.updatedAt', { time: time(card.observedAt, props.locale) })}
      </p>
      {troubled && props.onHelp ? (
        <div className="mt-2 flex flex-col items-start gap-1">
          <p className="text-xs text-text-muted">{t('shop.orderHelp')}</p>
          <Button variant="secondary" size="sm" onClick={props.onHelp}>
            {t('talkToPerson')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
