import { schema, type TenantTx } from '@hamnivo/db';
import type { CacheExclusionRule } from '@hamnivo/domain';
import {
  answerCacheDecision,
  type CompletionClaim,
  type LiveDataClass,
} from '@hamnivo/domain/commerce';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { CacheExclusions } from '../cache/store.js';

/**
 * K06: an answer that used commerce data (prices, stock, a quote, an order, a payment or a refund)
 * is never stored in, or served from, a cache. The answer cache asks this rule on every lookup and
 * every store; `answerCacheDecision` decides from the data classes the answer used.
 */
export const COMMERCE_CACHE_RULE: CacheExclusionRule = {
  id: 'commerce.live_data',
  check(request) {
    const decision = answerCacheDecision(request.dataClasses);
    return decision.cacheable ? null : decision.classes.join(',');
  },
};

/** Adds the commerce rule to the cache exclusions of this process (API and worker). */
@Injectable()
export class CommerceCacheRules implements OnModuleInit {
  constructor(private readonly exclusions: CacheExclusions) {}

  onModuleInit(): void {
    this.exclusions.register(COMMERCE_CACHE_RULE);
  }
}

/**
 * The commerce data a reply in this conversation may be built from: the catalog, carts and quotes
 * shown in it, and its payments, orders and refunds (their cards are in the history the model
 * reads). Read before the answer cache is asked.
 */
export async function conversationLiveData(
  tx: TenantTx,
  conversationId: string,
): Promise<LiveDataClass[]> {
  const has = (table: PgTable, column: PgColumn) =>
    sql`exists (select 1 from ${table} where ${column} = ${conversationId}::uuid)`;
  const { rows } = await tx.execute<{
    catalog: boolean;
    cart: boolean;
    quote: boolean;
    purchase: boolean;
    order: boolean;
    refund: boolean;
  }>(sql`
    select
      ${has(schema.catalogSnapshots, schema.catalogSnapshots.conversationId)} as catalog,
      ${has(schema.carts, schema.carts.conversationId)} as cart,
      ${has(schema.quotes, schema.quotes.conversationId)} as quote,
      ${has(schema.purchaseIntents, schema.purchaseIntents.conversationId)} as purchase,
      ${has(schema.orders, schema.orders.conversationId)} as "order",
      exists (
        select 1 from ${schema.refunds}
        join ${schema.orders} on ${schema.orders.id} = ${schema.refunds.orderId}
        where ${schema.orders.conversationId} = ${conversationId}::uuid
      ) as refund`);
  const found = rows[0];
  if (!found) return [];
  const classes = new Set<LiveDataClass>();
  if (found.catalog || found.cart) {
    classes.add('commerce.price');
    classes.add('commerce.stock');
  }
  if (found.quote) {
    classes.add('commerce.quote');
    classes.add('commerce.approval');
  }
  if (found.purchase) classes.add('commerce.payment_status');
  if (found.order) classes.add('commerce.order_status');
  if (found.refund) classes.add('commerce.refund_status');
  return [...classes];
}

const CLAIMED: Record<CompletionClaim, LiveDataClass> = {
  payment_completed: 'commerce.payment_status',
  refund_completed: 'commerce.refund_status',
};

/** What a reply's receipt check (X10) read: the payment or refund status it claims. */
export function claimedLiveData(claims: readonly string[]): LiveDataClass[] {
  return [
    ...new Set(
      claims.flatMap((claim) => (claim in CLAIMED ? [CLAIMED[claim as CompletionClaim]] : [])),
    ),
  ];
}
