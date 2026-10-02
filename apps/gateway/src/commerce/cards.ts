import type {
  CardPart,
  CatalogCard,
  CatalogItem,
  OrderStatusCard,
  QuoteCard,
  QuoteDocument,
  ReceiptCard,
} from '@hamnivo/contracts';
import type { z } from 'zod';
import { moneyText, sha256Hex } from './common.js';

/**
 * Cards are Hamnivo records shown in a conversation (G24). The Chatwoot message carries only a
 * reference, `content_attributes.hv.card = {type, id, hash}`, and a plain-text fallback for
 * agents and text-only channels; clients render the card from Hamnivo's record, whose canonical
 * hash must match. Values come from validated records, never from model text.
 */

type QuoteDoc = z.infer<typeof QuoteDocument>;
type Part = z.infer<typeof CardPart>;
type QuoteCardT = z.infer<typeof QuoteCard>;

export interface CardRef {
  type: Part['card']['kind'];
  id: string;
  hash: string;
}

export interface CardPublication {
  ref: CardRef;
  part: Part;
  /** Shown as the sender of the card (the seller), never as a person or the AI. */
  senderName: string;
}

/** Idempotency key of a card post in Chatwoot (`source_id`), one per record and occasion. */
export const cardKey = (uuid: string) => `hv1:c:${uuid}`;

export function quoteCard(doc: QuoteDoc, hash: string, merchantId: string): QuoteCardT {
  return {
    kind: 'quote',
    version: 1,
    quoteId: doc.quoteId,
    quoteHash: hash,
    merchant: { id: merchantId, name: doc.merchant.name },
    lines: doc.lines.map((l) => ({
      lineId: l.lineId,
      name: l.name.slice(0, 200),
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      totalMinor: l.totalMinor,
    })),
    currency: doc.currency,
    subtotalMinor: doc.subtotalMinor,
    discountMinor: doc.discountMinor,
    taxMinor: doc.taxMinor,
    shippingMinor: doc.shippingMinor,
    totalMinor: doc.totalMinor,
    recurring: doc.recurring,
    expiresAt: doc.expiresAt,
  };
}

function publication(card: Part['card'], id: string, fallbackText: string, senderName: string) {
  return {
    ref: { type: card.kind, id, hash: sha256Hex(card) },
    part: { type: 'card' as const, card, fallbackText: fallbackText.slice(0, 2000) },
    senderName,
  };
}

export function quotePublication(doc: QuoteDoc, hash: string, merchantId: string): CardPublication {
  const card = quoteCard(doc, hash, merchantId);
  const items = doc.lines
    .map((l) => `${l.quantity} × ${l.name} (${moneyText(BigInt(l.totalMinor), doc.currency)})`)
    .join(', ');
  const shipping =
    doc.shippingMinor !== null && BigInt(doc.shippingMinor) > 0n
      ? ` Delivery ${moneyText(BigInt(doc.shippingMinor), doc.currency)}.`
      : '';
  const text =
    `Order summary from ${doc.merchant.name}: ${items}.${shipping} ` +
    `Total ${moneyText(BigInt(doc.totalMinor), doc.currency)}. ` +
    'Approve it in the chat to pay on the secure payment page. ' +
    `This price is valid until ${doc.expiresAt.slice(11, 16)} UTC.`;
  // The card hash for a quote is the quote hash itself: what the customer approves.
  return {
    ref: { type: 'quote', id: doc.quoteId, hash },
    part: { type: 'card', card, fallbackText: text.slice(0, 2000) },
    senderName: doc.merchant.name,
  };
}

export function catalogPublication(card: z.infer<typeof CatalogCard>): CardPublication {
  const items = card.items
    .slice(0, 5)
    .map(
      (i: z.infer<typeof CatalogItem>) =>
        `${i.name}: ${moneyText(BigInt(i.unitPriceMinor), i.currency)}${
          i.availability === 'out_of_stock' ? ' (out of stock)' : ''
        }`,
    )
    .join('; ');
  const text =
    card.items.length === 0
      ? `No matching products at ${card.merchant.name} right now.`
      : `Products from ${card.merchant.name}: ${items}${card.items.length > 5 ? '; …' : ''}. ` +
        'Prices are checked again before you pay.';
  return publication(card, card.snapshotId, text, card.merchant.name);
}

export function receiptPublication(
  card: z.infer<typeof ReceiptCard>,
  senderName: string,
): CardPublication {
  return publication(card, card.receiptId, card.summary, senderName);
}

export function orderStatusPublication(
  card: z.infer<typeof OrderStatusCard>,
  senderName: string,
): CardPublication {
  return publication(card, card.orderId, card.summary, senderName);
}
