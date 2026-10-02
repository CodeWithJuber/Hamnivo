import { Button } from '@hamnivo/ui/components/button';
import { useTranslation } from 'react-i18next';
import { price } from './format.js';
import type { Commerce } from './useCommerce.js';

/** Shop entry and mini-cart above the composer (HNV-20-01, HNV-20-02). */
export function ShopBar(props: { commerce: Commerce; locale: string }) {
  const { t } = useTranslation();
  const { commerce, locale } = props;
  if (!commerce.shop) return null;
  const cart = commerce.cart;
  const items = cart?.itemCount ?? 0;
  return (
    <div className="mb-2 flex flex-col gap-1" data-testid="shop-bar">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="link"
          className="h-auto text-sm"
          disabled={commerce.busy !== null}
          onClick={() => void commerce.browse()}
        >
          {t('shop.browse')}
        </Button>
        {items > 0 && cart ? (
          <>
            <span className="text-sm text-text" aria-live="polite" data-testid="cart-summary">
              {t('shop.cartSummary', { count: items })}
              {cart.estimatedSubtotalMinor
                ? ` · ${t('shop.estimate', { amount: price(cart.estimatedSubtotalMinor, cart.currency, locale) })}`
                : ''}
            </span>
            <Button
              size="sm"
              disabled={commerce.busy !== null || cart.status !== 'open'}
              onClick={() => void commerce.review()}
            >
              {t('shop.review')}
            </Button>
          </>
        ) : null}
      </div>
      {commerce.error ? (
        <p role="alert" className="text-xs text-danger">
          {t(`shop.error.${commerce.error}`)}
        </p>
      ) : null}
    </div>
  );
}
