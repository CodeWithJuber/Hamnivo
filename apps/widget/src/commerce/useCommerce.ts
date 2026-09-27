import {
  type Cart,
  type Catalog,
  CommerceApi,
  HamnivoApiError,
  type HamnivoClient,
  type Purchase,
  type Quote,
  type Shop,
} from '@hamnivo/client';
import { type QuoteDocument, quoteHash } from '@hamnivo/domain/commerce';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Error message keys shown next to the shop controls (translated by the caller). */
export type CommerceError =
  | 'cartChanged'
  | 'expired'
  | 'unavailable'
  | 'unsupported'
  | 'mismatch'
  | 'generic';

function errorKey(error: unknown): CommerceError {
  if (!(error instanceof HamnivoApiError)) return 'generic';
  switch (error.code) {
    case 'VERSION_CONFLICT':
      return 'cartChanged';
    case 'QUOTE_EXPIRED':
      return 'expired';
    case 'APPROVAL_MISMATCH':
      return 'mismatch';
    case 'PROVIDER_UNAVAILABLE':
    case 'NETWORK':
      return 'unavailable';
    case 'CAPABILITY_UNSUPPORTED':
    case 'FEATURE_DISABLED':
      return 'unsupported';
    default:
      return 'generic';
  }
}

/** Outcomes where the widget keeps watching for the provider's answer. */
const WAITING = new Set<Purchase['outcome']>([
  'preparing_checkout',
  'awaiting_payment',
  'confirming',
]);

/**
 * The shop inside one conversation: live catalog cards, the cart, quotes and purchases. Quotes
 * are always re-read from the server, and the approval button is enabled only when the quote the
 * server returns hashes to exactly what it claims (the same RFC 8785 + SHA-256 as the server).
 */
export function useCommerce(client: HamnivoClient, conversationId: string | null) {
  const api = useMemo(() => new CommerceApi(client), [client]);
  const [shop, setShop] = useState<Shop | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<CommerceError | null>(null);
  /** One request id per quote, so a repeated tap approves the same purchase. */
  const requestIds = useRef(new Map<string, string>());
  const loading = useRef(new Set<string>());
  const quotesRef = useRef(quotes);
  quotesRef.current = quotes;

  const load = useCallback(async () => {
    if (!conversationId) return;
    try {
      const result = await api.getCart(conversationId);
      setShop(result.shop);
      setCart(result.cart);
    } catch {
      setShop(null);
    }
  }, [api, conversationId]);

  useEffect(() => {
    setShop(null);
    setCart(null);
    setQuotes({});
    void load();
  }, [load]);

  const run = useCallback(
    async <T>(label: string, work: () => Promise<T>): Promise<T | null> => {
      setBusy(label);
      setError(null);
      try {
        return await work();
      } catch (cause) {
        const key = errorKey(cause);
        setError(key);
        if (key === 'cartChanged') await load();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const remember = useCallback((quote: Quote) => {
    setQuotes((all) => ({ ...all, [quote.id]: quote }));
  }, []);

  /** Loads the live state of a quote shown in the conversation (once, unless refreshed). */
  const ensureQuote = useCallback(
    async (quoteId: string, force = false) => {
      if (!conversationId || (!force && loading.current.has(quoteId))) return;
      loading.current.add(quoteId);
      try {
        remember(await api.getQuote(conversationId, quoteId));
      } catch {
        loading.current.delete(quoteId);
      }
    },
    [api, conversationId, remember],
  );

  const setPurchase = useCallback((quoteId: string, purchase: Purchase) => {
    setQuotes((all) => {
      const quote = all[quoteId];
      return quote ? { ...all, [quoteId]: { ...quote, intent: purchase } } : all;
    });
  }, []);

  const browse = useCallback(
    () => (conversationId ? run('browse', () => api.searchCatalog(conversationId)) : null),
    [api, conversationId, run],
  );

  /** Sets how many of an item are in the cart (0 removes it). */
  const setQuantity = useCallback(
    (
      catalog: Catalog | null,
      item: { productId: string; variantId: string | null },
      quantity: number,
    ) =>
      conversationId
        ? run(`item:${item.productId}`, async () => {
            const lines = (cart?.lines ?? [])
              .filter((l) => !(l.productId === item.productId && l.variantId === item.variantId))
              .map((l) => ({
                productId: l.productId,
                variantId: l.variantId,
                quantity: l.quantity,
              }));
            if (quantity > 0) lines.push({ ...item, quantity: Math.min(quantity, 99) });
            const updated = await api.updateCart(conversationId, {
              expectedRevision: cart?.revision ?? null,
              lines,
              ...(catalog ? { catalogId: catalog.snapshotId } : {}),
            });
            setCart(updated);
            return updated;
          })
        : null,
    [api, cart, conversationId, run],
  );

  const review = useCallback(
    () =>
      conversationId && cart
        ? run('review', async () => {
            const quote = await api.requestQuote(conversationId, cart.revision);
            remember(quote);
            loading.current.add(quote.id);
            return quote;
          })
        : null,
    [api, cart, conversationId, remember, run],
  );

  /** The quote as served hashes to exactly what it says (the widget checks before approval). */
  const verified = useCallback(
    (quote: Quote, cardHash: string) =>
      quote.hash === cardHash && quoteHash(quote.document as QuoteDocument) === quote.hash,
    [],
  );

  const approve = useCallback(
    (quote: Quote) =>
      conversationId
        ? run(`approve:${quote.id}`, async () => {
            let requestId = requestIds.current.get(quote.id);
            if (!requestId) {
              requestId = crypto.randomUUID();
              requestIds.current.set(quote.id, requestId);
            }
            const purchase = await api.approve(conversationId, quote.id, {
              quoteHash: quote.hash,
              cartRevision: quote.document.cart.revision,
              clientRequestId: requestId,
            });
            setPurchase(quote.id, purchase);
            await ensureQuote(quote.id, true);
            return purchase;
          })
        : null,
    [api, conversationId, ensureQuote, run, setPurchase],
  );

  const checkStatus = useCallback(
    (quoteId: string, purchaseId: string) =>
      conversationId
        ? run(`status:${purchaseId}`, async () => {
            const purchase = await api.refreshPurchase(conversationId, purchaseId);
            setPurchase(quoteId, purchase);
            if (!WAITING.has(purchase.outcome)) void load();
            return purchase;
          })
        : null,
    [api, conversationId, load, run, setPurchase],
  );

  const cancel = useCallback(
    (quoteId: string, purchaseId: string) =>
      conversationId
        ? run(`cancel:${purchaseId}`, async () => {
            const purchase = await api.cancelPurchase(conversationId, purchaseId);
            setPurchase(quoteId, purchase);
            await load();
            return purchase;
          })
        : null,
    [api, conversationId, load, run, setPurchase],
  );

  /** Live events from the conversation stream: purchases and approvals that changed. */
  const onEvent = useCallback(
    (event: { type: string; data?: Record<string, unknown> }) => {
      const data = event.data ?? {};
      if (event.type === 'approval.updated' && typeof data.approvalId === 'string') {
        void ensureQuote(data.approvalId, true);
      }
      if (event.type === 'action.updated' && typeof data.actionId === 'string') {
        const actionId = data.actionId;
        if (!actionId.startsWith('pur_')) return;
        const match = Object.values(quotesRef.current).find((q) => q.intent?.id === actionId);
        if (match) void ensureQuote(match.id, true);
        void load();
      }
    },
    [ensureQuote, load],
  );

  // Coming back from the payment page (focus) asks the server once for the provider's answer.
  useEffect(() => {
    const onFocus = () => {
      for (const quote of Object.values(quotes)) {
        if (quote.intent && WAITING.has(quote.intent.outcome)) {
          void checkStatus(quote.id, quote.intent.id);
        }
      }
    };
    window.addEventListener('focus', onFocus);
    const channel =
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('hamnivo-checkout');
    if (channel) channel.onmessage = onFocus;
    return () => {
      window.removeEventListener('focus', onFocus);
      channel?.close();
    };
  }, [checkStatus, quotes]);

  return {
    shop,
    cart,
    quotes,
    busy,
    error,
    browse,
    setQuantity,
    review,
    ensureQuote,
    verified,
    approve,
    checkStatus,
    cancel,
    onEvent,
    reload: load,
  };
}

export type Commerce = ReturnType<typeof useCommerce>;
