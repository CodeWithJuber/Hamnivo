import type { CatalogResult, ProviderQuote } from '@hamnivo/adapters/commerce';
import type {
  CartView,
  CatalogCard,
  QuoteView,
  ShareCatalogRequest,
  UpdateCartRequest,
} from '@hamnivo/contracts';
import {
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import {
  type QuoteDocument,
  quoteExpiry,
  quoteHash,
  verifyQuoteArithmetic,
} from '@hamnivo/domain/commerce';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import { JournalService } from '../authority/journal.service.js';
import type { ControlRow } from '../authority/ownership.service.js';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import {
  activeMerchant,
  brandScope,
  customerConversation,
  decide,
  requireBrand,
  requireCapability,
  requireMerchant,
} from './access.js';
import { CommerceCardsService } from './card-publisher.service.js';
import { catalogPublication, quotePublication } from './cards.js';
import { type CommerceActor, minor, providerProblem } from './common.js';
import { Effects } from './effects.js';
import { CommerceProviders, type MerchantRow } from './providers.service.js';
import { type CartRow, cartView, quoteView } from './views.js';

type CatalogCardT = z.infer<typeof CatalogCard>;

/** Items per catalog card. */
const CATALOG_LIMIT = 8;

/**
 * Catalog, cart and exact quote (C02, C03). Product facts are read live from the merchant and
 * shown with their time and source; the cart holds only what the customer chose; the quote is
 * priced by the merchant again every time, checked to add up exactly, and hashed so the approval
 * binds to exactly what was shown (K06: nothing here is served from a cache).
 */
@Injectable()
export class CartsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly providers: CommerceProviders,
    private readonly cards: CommerceCardsService,
    private readonly journal: JournalService,
  ) {}

  private customerTx<T>(claims: WidgetClaims, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: claims.tenantId, actorId: toPublicId('customer', claims.principalId) },
      work,
    );
  }

  private async activeCart(tx: TenantTx, control: ControlRow, principalId: string) {
    const [cart] = await tx
      .select()
      .from(schema.carts)
      .where(
        and(
          eq(schema.carts.conversationId, control.id),
          eq(schema.carts.principalId, principalId),
          inArray(schema.carts.status, ['open', 'locked']),
        ),
      )
      .for('update');
    return cart ?? null;
  }

  // ── Catalog (C02) ─────────────────────────────────────────────────────────────────────────

  /** Reads the merchant's catalog now and records what was shown, as a card in the chat. */
  private async catalog(
    tenantId: string,
    actor: CommerceActor,
    load: (tx: TenantTx) => Promise<{ control: ControlRow; merchant: MerchantRow }>,
    input: { query?: string; productIds?: string[] },
  ): Promise<CatalogCardT> {
    const prepared = await withTenant(
      this.db,
      { tenantId, actorId: actor.id ?? 'commerce' },
      async (tx) => {
        const { control, merchant } = await load(tx);
        requireCapability(merchant, 'catalog.search');
        return { control, merchant, provider: await this.providers.forConnection(tx, merchant) };
      },
    );
    const { control, merchant, provider } = prepared;
    const currency = merchant.config.currencies[0] ?? '';
    let result: CatalogResult;
    try {
      result = await provider.searchCatalog({
        ...(input.query ? { text: input.query } : {}),
        limit: 50,
      });
    } catch (error) {
      throw providerProblem(error, 'The shop could not be reached. Please try again in a moment.');
    }
    const wanted = input.productIds?.length ? new Set(input.productIds) : null;
    const items = result.items
      .filter((item) => item.currency === currency && item.recurring === null)
      .filter((item) => !wanted || wanted.has(item.productId))
      .slice(0, CATALOG_LIMIT)
      .map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        name: item.name.slice(0, 200),
        description: item.description?.slice(0, 500) ?? null,
        unitPriceMinor: minor(item.unitPriceMinor),
        currency: item.currency,
        availability: item.availability,
        stockQuantity: item.stockQuantity,
        imageUrl: item.imageUrl,
      }));
    const snapshotId = newId();
    const card: CatalogCardT = {
      kind: 'catalog',
      version: 1,
      snapshotId: toPublicId('catalog', snapshotId),
      merchant: { id: toPublicId('merchant', merchant.id), name: merchant.displayName },
      items,
      observedAt: result.observedAt.toISOString(),
      source: result.source.slice(0, 80),
    };
    await withTenant(this.db, { tenantId, actorId: actor.id ?? 'commerce' }, async (tx) => {
      await tx.insert(schema.catalogSnapshots).values({
        id: snapshotId,
        tenantId,
        merchantConnectionId: merchant.id,
        conversationId: control.id,
        query: input.query ?? null,
        items: items as unknown as Record<string, unknown>[],
        itemCount: items.length,
        source: card.source,
        observedAt: result.observedAt,
        createdByType: actor.type,
        createdById: actor.id,
      });
      await this.cards.enqueue(
        tx,
        tenantId,
        control,
        catalogPublication(card),
        `catalog:${snapshotId}`,
      );
    });
    return card;
  }

  /** The customer asks to see products (HNV-20-01). */
  searchCatalog(claims: WidgetClaims, conversationId: string, input: { query?: string }) {
    return this.catalog(
      claims.tenantId,
      { type: 'customer', id: toPublicId('customer', claims.principalId) },
      async (tx) => {
        const control = await customerConversation(tx, claims, conversationId);
        return { control, merchant: requireMerchant(await activeMerchant(tx, control.brandId)) };
      },
      input,
    );
  }

  /** A team member shows the customer products (E12: people and AI propose, never price). */
  shareCatalog(
    principal: StaffPrincipal,
    conversationId: string,
    input: z.output<typeof ShareCatalogRequest>,
  ) {
    const options = {
      now: this.clock(),
      stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
    };
    return this.catalog(
      principal.tenantId,
      { type: 'staff', id: toPublicId('staff', principal.staffMemberId) },
      async (tx) => {
        const [control] = await tx
          .select()
          .from(schema.conversationControls)
          .where(eq(schema.conversationControls.id, fromPublicId('conversation', conversationId)));
        const scope = control?.brandId ? await brandScope(tx, control.brandId) : null;
        requireBrand(principal, 'commerce.read', scope, options, 'Conversation not found.');
        if (!control || !scope) throw new AppError('NOT_FOUND');
        enforce(decide(principal, 'commerce.carts.manage', scope, options));
        return { control, merchant: requireMerchant(await activeMerchant(tx, control.brandId)) };
      },
      {
        ...(input.query ? { query: input.query } : {}),
        ...(input.productIds ? { productIds: input.productIds } : {}),
      },
    );
  }

  /** A catalog card shown in this conversation, as it was recorded. */
  getCatalog(claims: WidgetClaims, conversationId: string, catalogPublicId: string) {
    return this.customerTx(claims, async (tx) => {
      const control = await customerConversation(tx, claims, conversationId);
      const [snapshot] = await tx
        .select()
        .from(schema.catalogSnapshots)
        .where(
          and(
            eq(schema.catalogSnapshots.id, fromPublicId('catalog', catalogPublicId)),
            eq(schema.catalogSnapshots.conversationId, control.id),
          ),
        );
      if (!snapshot) throw new AppError('NOT_FOUND', { detail: 'Catalog not found.' });
      const [merchant] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, snapshot.merchantConnectionId));
      return {
        kind: 'catalog',
        version: 1,
        snapshotId: catalogPublicId,
        merchant: {
          id: toPublicId('merchant', snapshot.merchantConnectionId),
          name: merchant?.displayName ?? '',
        },
        items: snapshot.items as unknown as CatalogCardT['items'],
        observedAt: snapshot.observedAt.toISOString(),
        source: snapshot.source,
      } satisfies CatalogCardT;
    });
  }

  // ── Cart ──────────────────────────────────────────────────────────────────────────────────

  async getCart(claims: WidgetClaims, conversationId: string) {
    return this.customerTx(claims, async (tx) => {
      const control = await customerConversation(tx, claims, conversationId);
      const merchant = await activeMerchant(tx, control.brandId);
      const cart = await this.activeCart(tx, control, claims.principalId);
      const cartMerchant =
        cart && cart.merchantConnectionId !== merchant?.id
          ? (
              await tx
                .select()
                .from(schema.merchantConnections)
                .where(eq(schema.merchantConnections.id, cart.merchantConnectionId))
            )[0]
          : merchant;
      return {
        cart: cart && cartMerchant ? cartView(cart, cartMerchant) : null,
        shop: merchant
          ? {
              merchantId: toPublicId('merchant', merchant.id),
              name: merchant.displayName,
              currency: merchant.config.currencies[0] ?? '',
            }
          : null,
      };
    });
  }

  /** Replaces the cart lines; a stale revision means another change came first (409). */
  async updateCart(
    claims: WidgetClaims,
    conversationId: string,
    input: z.output<typeof UpdateCartRequest>,
  ): Promise<z.infer<typeof CartView>> {
    const effects = new Effects();
    const view = await this.customerTx(claims, async (tx) => {
      const control = await customerConversation(tx, claims, conversationId);
      const merchant = requireMerchant(await activeMerchant(tx, control.brandId));
      const lines = this.normalize(input.lines);
      const known = await this.knownItems(tx, control, merchant, input.catalogId);
      const cart = await this.activeCart(tx, control, claims.principalId);
      if (cart?.status === 'locked') {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Your order is at the payment step. Finish or cancel the payment to change it.',
        });
      }
      if ((cart?.revision ?? null) !== input.expectedRevision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Your cart changed in another window. Please review it again.',
        });
      }
      const priced = lines.map((line) => {
        const previous = cart?.lines.find(
          (l) => l.productId === line.productId && l.variantId === line.variantId,
        );
        const item = known.get(`${line.productId}:${line.variantId ?? ''}`);
        return {
          ...line,
          name: item?.name ?? previous?.name ?? null,
          unitPriceMinor: item?.unitPriceMinor ?? previous?.unitPriceMinor ?? null,
        };
      });
      const now = this.clock();
      let written: CartRow | undefined;
      if (!cart) {
        [written] = await tx
          .insert(schema.carts)
          .values({
            tenantId: claims.tenantId,
            conversationId: control.id,
            principalId: claims.principalId,
            merchantConnectionId: merchant.id,
            currency: merchant.config.currencies[0] ?? '',
            lines: priced,
          })
          .returning();
      } else {
        [written] = await tx
          .update(schema.carts)
          .set({ lines: priced, revision: cart.revision + 1, updatedAt: now })
          .where(eq(schema.carts.id, cart.id))
          .returning();
        if (written) await this.supersedeQuotes(tx, claims.tenantId, control, written, effects);
      }
      if (!written) throw new Error('cart write returned nothing');
      return cartView(written, merchant);
    });
    await effects.flush(this.journal);
    return view;
  }

  private normalize(lines: z.output<typeof UpdateCartRequest>['lines']) {
    const merged = new Map<
      string,
      { productId: string; variantId: string | null; quantity: number }
    >();
    for (const line of lines) {
      const key = `${line.productId}:${line.variantId ?? ''}`;
      const quantity = (merged.get(key)?.quantity ?? 0) + line.quantity;
      if (quantity > 99) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'lines', message: 'At most 99 of one item.' }],
        });
      }
      merged.set(key, { productId: line.productId, variantId: line.variantId, quantity });
    }
    return [...merged.values()];
  }

  /** Names and shown prices from the catalog card the items came from (estimates only). */
  private async knownItems(
    tx: TenantTx,
    control: ControlRow,
    merchant: MerchantRow,
    catalogId: string | undefined,
  ): Promise<Map<string, { name: string; unitPriceMinor: string }>> {
    const snapshots = await tx
      .select()
      .from(schema.catalogSnapshots)
      .where(
        and(
          eq(schema.catalogSnapshots.conversationId, control.id),
          eq(schema.catalogSnapshots.merchantConnectionId, merchant.id),
          ...(catalogId
            ? [eq(schema.catalogSnapshots.id, fromPublicId('catalog', catalogId))]
            : []),
        ),
      )
      .orderBy(desc(schema.catalogSnapshots.observedAt))
      .limit(catalogId ? 1 : 5);
    const known = new Map<string, { name: string; unitPriceMinor: string }>();
    for (const snapshot of [...snapshots].reverse()) {
      for (const item of snapshot.items as unknown as CatalogCardT['items']) {
        known.set(`${item.productId}:${item.variantId ?? ''}`, {
          name: item.name,
          unitPriceMinor: item.unitPriceMinor,
        });
      }
    }
    return known;
  }

  /** A changed cart invalidates its quotes: shown prices no longer match what is in the cart. */
  private async supersedeQuotes(
    tx: TenantTx,
    tenantId: string,
    control: ControlRow,
    cart: CartRow,
    effects: Effects,
  ) {
    const stale = await tx
      .update(schema.quotes)
      .set({ status: 'superseded', updatedAt: this.clock() })
      .where(and(eq(schema.quotes.cartId, cart.id), eq(schema.quotes.status, 'ready')))
      .returning({ id: schema.quotes.id });
    if (stale.length === 0) return;
    await tx
      .update(schema.purchaseIntents)
      .set({ state: 'cancelled', updatedAt: this.clock() })
      .where(
        and(
          inArray(
            schema.purchaseIntents.quoteId,
            stale.map((q) => q.id),
          ),
          eq(schema.purchaseIntents.state, 'awaiting_approval'),
        ),
      );
    effects.add(
      tenantId,
      control.id,
      await this.journal.append(
        tx,
        tenantId,
        control.id,
        stale.map((q) => ({
          lane: 'customer' as const,
          type: 'approval.updated' as const,
          data: { approvalId: toPublicId('quote', q.id), status: 'superseded' },
        })),
      ),
    );
  }

  // ── Exact quote (C03) ─────────────────────────────────────────────────────────────────────

  async requestQuote(
    claims: WidgetClaims,
    conversationId: string,
    cartRevision: number,
  ): Promise<QuoteView> {
    const prepared = await this.customerTx(claims, async (tx) => {
      const control = await customerConversation(tx, claims, conversationId);
      const cart = await this.activeCart(tx, control, claims.principalId);
      if (cart?.status !== 'open') {
        throw new AppError('VERSION_CONFLICT', { detail: 'There is no open cart to review.' });
      }
      if (cart.revision !== cartRevision) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Your cart changed. Please review it again.',
        });
      }
      if (cart.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [{ path: 'lines', message: 'Your cart is empty.' }],
        });
      }
      const [merchant] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, cart.merchantConnectionId));
      if (merchant?.status !== 'active') requireMerchant(null);
      const active = merchant as MerchantRow;
      requireCapability(active, 'quote', { currency: cart.currency });
      requireCapability(active, 'checkout.hosted', { currency: cart.currency });
      return {
        control,
        cart,
        merchant: active,
        provider: await this.providers.forConnection(tx, active),
      };
    });
    const { control, cart, merchant, provider } = prepared;
    let priced: ProviderQuote;
    try {
      // Always read live (K06): a price or stock level shown earlier is never reused.
      priced = await provider.quote({
        lines: cart.lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
        })),
        currency: cart.currency,
        country: null,
      });
    } catch (error) {
      throw providerProblem(error, 'The shop could not price your cart. Please try again.');
    }
    const now = this.clock();
    const quoteId = newId();
    const expiresAt = quoteExpiry(now, priced.validUntil, merchant.config.quoteMinutes ?? 15);
    const doc: QuoteDocument = {
      v: 1,
      quoteId: toPublicId('quote', quoteId),
      merchant: { connectionId: toPublicId('merchant', merchant.id), name: merchant.displayName },
      cart: { id: toPublicId('cart', cart.id), revision: cart.revision },
      currency: priced.currency,
      lines: priced.lines.map((line, index) => ({
        lineId: `l${index + 1}`,
        productId: line.productId,
        variantId: line.variantId,
        name: line.name.slice(0, 200),
        quantity: line.quantity,
        unitPriceMinor: minor(line.unitPriceMinor),
        totalMinor: minor(line.totalMinor),
      })),
      subtotalMinor: minor(priced.subtotalMinor),
      discountMinor: minor(priced.discountMinor),
      taxMinor: priced.taxMinor === null ? null : minor(priced.taxMinor),
      taxMode: priced.taxMode,
      shippingMinor: priced.shippingMinor === null ? null : minor(priced.shippingMinor),
      totalMinor: minor(priced.totalMinor),
      recurring: null,
      delivery: null,
      expiresAt: expiresAt.toISOString(),
    };
    try {
      verifyQuoteArithmetic(doc);
    } catch (error) {
      throw new AppError('PROVIDER_UNAVAILABLE', {
        detail: 'The shop sent a price that does not add up, so it was not shown.',
        retryable: false,
        internal: error instanceof Error ? error.message : 'arithmetic',
      });
    }
    const hash = quoteHash(doc);
    const effects = new Effects();
    const view = await this.customerTx(claims, async (tx) => {
      const current = await this.activeCart(tx, control, claims.principalId);
      if (
        !current ||
        current.id !== cart.id ||
        current.revision !== cart.revision ||
        current.status !== 'open'
      ) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'Your cart changed while it was being priced. Please review it again.',
        });
      }
      await this.supersedeQuotes(tx, claims.tenantId, control, current, effects);
      const [quote] = await tx
        .insert(schema.quotes)
        .values({
          id: quoteId,
          tenantId: claims.tenantId,
          cartId: cart.id,
          cartRevision: cart.revision,
          conversationId: control.id,
          principalId: claims.principalId,
          merchantConnectionId: merchant.id,
          approver: 'customer',
          currency: doc.currency,
          document: doc as unknown as Record<string, unknown>,
          hash: Buffer.from(hash, 'hex'),
          subtotalMinor: priced.subtotalMinor,
          discountMinor: priced.discountMinor,
          taxMinor: priced.taxMinor,
          shippingMinor: priced.shippingMinor,
          totalMinor: priced.totalMinor,
          expiresAt,
          createdByType: 'customer',
          createdById: toPublicId('customer', claims.principalId),
        })
        .returning();
      const [intent] = await tx
        .insert(schema.purchaseIntents)
        .values({
          tenantId: claims.tenantId,
          conversationId: control.id,
          principalId: claims.principalId,
          merchantConnectionId: merchant.id,
          cartId: cart.id,
          quoteId,
          // draft → quoted → awaiting_approval: the card is shown in the same step.
          state: 'awaiting_approval',
        })
        .returning();
      if (!quote || !intent) throw new Error('quote write returned nothing');
      await this.cards.enqueue(
        tx,
        claims.tenantId,
        control,
        quotePublication(doc, hash, toPublicId('merchant', merchant.id)),
        `quote:${quoteId}`,
      );
      return quoteView({ quote, intent, payment: null, order: null, merchant, now });
    });
    await effects.flush(this.journal);
    return view;
  }
}
