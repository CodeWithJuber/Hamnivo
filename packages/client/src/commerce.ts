import type {
  CartView,
  CatalogCard,
  CustomerOrderView,
  PurchaseIntentView,
  QuoteView,
  ShopInfo,
} from '@hamnivo/contracts';
import type { HamnivoClient } from './client.js';

export type Cart = CartView;
export type Catalog = CatalogCard;
export type Quote = QuoteView;
export type Purchase = PurchaseIntentView;
export type CustomerOrder = CustomerOrderView;
export type Shop = ShopInfo;

export interface CartLineInput {
  productId: string;
  variantId: string | null;
  quantity: number;
}

/**
 * Shopping in a conversation (widget API): catalog cards, the cart, the exact quote, approval,
 * the provider-hosted payment page and the order. Nothing is cached: every call reads live
 * records, and payment is only ever "paid" when the server says the provider confirmed it.
 */
export class CommerceApi {
  constructor(private readonly client: HamnivoClient) {}

  private path(conversationId: string, rest: string) {
    return `/v1/widget/conversations/${encodeURIComponent(conversationId)}/commerce/${rest}`;
  }

  searchCatalog(conversationId: string, query?: string): Promise<Catalog> {
    return this.client.request(
      'POST',
      this.path(conversationId, 'catalogs'),
      query ? { query } : {},
    );
  }

  getCatalog(conversationId: string, catalogId: string): Promise<Catalog> {
    return this.client.request(
      'GET',
      this.path(conversationId, `catalogs/${encodeURIComponent(catalogId)}`),
    );
  }

  getCart(conversationId: string): Promise<{ cart: Cart | null; shop: Shop | null }> {
    return this.client.request('GET', this.path(conversationId, 'cart'));
  }

  /** Replaces the lines; fails with VERSION_CONFLICT when the cart changed elsewhere first. */
  updateCart(
    conversationId: string,
    input: { expectedRevision: number | null; lines: CartLineInput[]; catalogId?: string },
  ): Promise<Cart> {
    return this.client.request('POST', this.path(conversationId, 'cart'), input);
  }

  requestQuote(conversationId: string, cartRevision: number): Promise<Quote> {
    return this.client.request('POST', this.path(conversationId, 'cart/quote'), { cartRevision });
  }

  getQuote(conversationId: string, quoteId: string): Promise<Quote> {
    return this.client.request(
      'GET',
      this.path(conversationId, `quotes/${encodeURIComponent(quoteId)}`),
    );
  }

  /** Approves exactly this quote (its hash and cart revision); the same request id is safe to repeat. */
  approve(
    conversationId: string,
    quoteId: string,
    input: { quoteHash: string; cartRevision: number; clientRequestId: string },
  ): Promise<Purchase> {
    return this.client.request(
      'POST',
      this.path(conversationId, `quotes/${encodeURIComponent(quoteId)}/approve`),
      input,
    );
  }

  getPurchase(conversationId: string, purchaseId: string): Promise<Purchase> {
    return this.client.request(
      'GET',
      this.path(conversationId, `purchases/${encodeURIComponent(purchaseId)}`),
    );
  }

  /** "Check status": the server asks the payment provider (rate limited). */
  refreshPurchase(conversationId: string, purchaseId: string): Promise<Purchase> {
    return this.client.request(
      'POST',
      this.path(conversationId, `purchases/${encodeURIComponent(purchaseId)}/refresh`),
    );
  }

  cancelPurchase(conversationId: string, purchaseId: string): Promise<Purchase> {
    return this.client.request(
      'POST',
      this.path(conversationId, `purchases/${encodeURIComponent(purchaseId)}/cancel`),
    );
  }

  getOrder(conversationId: string, orderId: string): Promise<CustomerOrder> {
    return this.client.request(
      'GET',
      this.path(conversationId, `orders/${encodeURIComponent(orderId)}`),
    );
  }
}
