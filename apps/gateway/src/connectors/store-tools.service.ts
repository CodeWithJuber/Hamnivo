import { type EgressPolicy, hostAllowed } from '@hamnivo/adapters/net';
import { callShopify, callWooCommerce, StoreApiError } from '@hamnivo/adapters/stores';
import { type Db, schema, type TenantTx, withTenant } from '@hamnivo/db';
import {
  emailOf,
  orderNumberOf,
  publicOrder,
  STORE_ORDER_LIMIT,
  STORE_SPEC,
  type StoreCapability,
  type StoreKind,
  type StoreOrder,
  sameEmail,
  shopifyOrders,
  storeCapability,
  storeKind,
  wooOrder,
} from '@hamnivo/domain/connectors';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Prepared, ToolOutcome, ToolRow, ToolScope } from '../actions/adapters.js';
import { EgressService } from '../developer/egress.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB } from '../tokens.js';
import { ToolCallFailure } from './tool-call-failure.js';

type Args = Record<string, unknown>;
type Found = StoreOrder & { email: string | null };
interface StoreCall {
  baseUrl: string;
  policy: EgressPolicy;
  timeoutMs: number;
  signal: AbortSignal;
}

const PRODUCT: Record<StoreKind, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce' };

const unavailable = () =>
  new ToolCallFailure('store_unavailable', 'The store could not be checked right now.', false);
const notSignedIn = () =>
  new ToolCallFailure(
    'store_not_signed_in',
    'Only a customer the website signed in, with a verified email, can see their orders. Ask for the order number and the email it was placed with instead.',
    false,
  );
const badLookup = () =>
  new ToolCallFailure(
    'store_invalid',
    'Ask for the order number (such as #1001) and the email address the order was placed with.',
    false,
  );

/** What a failed store read says to the assistant: never the store's own answer. */
function failure(kind: StoreKind, error: unknown): ToolCallFailure {
  if (error instanceof ToolCallFailure) return error;
  if (!(error instanceof StoreApiError)) return unavailable();
  const product = PRODUCT[kind];
  const message =
    error.kind === 'rate_limited'
      ? `${product} is busy; try the lookup again in a minute.`
      : error.kind === 'auth' || error.kind === 'not_found' || error.kind === 'egress'
        ? `${product} could not be read; the team needs to check the connection in Studio.`
        : `${product} did not answer; try again in a moment.`;
  return new ToolCallFailure(`store_${error.kind}`, message, false);
}

/** The number a customer reads on their receipt, compared without # or case. */
const numberKey = (value: string) => value.trim().replace(/^#/, '').toLowerCase();

/**
 * Shopify and WooCommerce orders for the assistant, read only (`orders.read`, `order.status`).
 * A signed-in customer's orders are found by the email the website verified; one order needs its
 * number and the email it was placed with, as a store's own track-my-order page asks. An order
 * whose email does not match is treated as no order at all.
 */
@Injectable()
export class StoreTools {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
  ) {}

  private async context(tx: TenantTx, tool: ToolRow, scope: ToolScope) {
    const capability = tool.remoteName ?? '';
    if (tool.brandId !== scope.brandId || !storeCapability(capability)) throw unavailable();
    if (tool.status !== 'enabled' || tool.risk !== 'read') throw unavailable();
    const [grant] = await tx
      .select()
      .from(schema.connectorToolGrants)
      .where(
        and(
          eq(schema.connectorToolGrants.toolId, tool.id),
          eq(schema.connectorToolGrants.enabled, 'yes'),
        ),
      );
    if (!grant || grant.capability !== capability) throw unavailable();
    const [connection] = await tx
      .select()
      .from(schema.connectorConnections)
      .where(
        and(
          eq(schema.connectorConnections.id, grant.connectionId),
          eq(schema.connectorConnections.brandId, scope.brandId),
        ),
      );
    if (
      connection?.status !== 'active' ||
      !storeKind(connection.kind) ||
      grant.version !== connection.grantVersion ||
      !hostAllowed(new URL(connection.baseUrl).hostname, tool.egressHosts)
    )
      throw unavailable();
    const kind: StoreKind = connection.kind;
    const credentials = {
      key: connection.identifierSecretId
        ? await this.secrets.reveal(tx, scope.tenantId, connection.identifierSecretId)
        : '',
      secret: await this.secrets.reveal(tx, scope.tenantId, connection.tokenSecretId),
    };
    if (kind === 'woocommerce' && !credentials.key) throw unavailable();
    const policy = await this.egress.policyIn(tx, []);
    return { capability: capability as StoreCapability, kind, connection, credentials, policy };
  }

  /** The email the website verified for this conversation's customer, if it did. */
  private async verifiedEmail(tx: TenantTx, scope: ToolScope): Promise<string | null> {
    if (!scope.principalId) return null;
    const [principal] = await tx
      .select()
      .from(schema.customerPrincipals)
      .where(
        and(
          eq(schema.customerPrincipals.id, scope.principalId),
          eq(schema.customerPrincipals.brandId, scope.brandId),
        ),
      );
    if (principal?.kind !== 'verified' || !principal.emailVerifiedAt) return null;
    return emailOf(principal.email);
  }

  async prepare(tx: TenantTx, tool: ToolRow, args: Args, scope: ToolScope): Promise<Prepared> {
    try {
      const ctx = await this.context(tx, tool, scope);
      if (ctx.capability === 'orders.read') {
        if (!(await this.verifiedEmail(tx, scope))) throw notSignedIn();
      } else if (!orderNumberOf(args.orderNumber) || !emailOf(args.email)) {
        throw badLookup();
      }
      return {
        ok: true,
        proposal: {
          summary: STORE_SPEC[ctx.capability].title,
          effects: [],
          changes: [],
          amount: null,
          resource: {
            type: 'store',
            id: `${ctx.connection.id}:${ctx.capability}`,
            label: `${PRODUCT[ctx.kind]} orders`,
            revision: null,
          },
        },
      };
    } catch (error) {
      return {
        ok: false,
        summary: error instanceof ToolCallFailure ? error.message : unavailable().message,
      };
    }
  }

  async execute(
    tool: ToolRow,
    args: Args,
    scope: ToolScope,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<ToolOutcome> {
    const ctx = await withTenant(
      this.db,
      { tenantId: scope.tenantId, actorId: 'ai' },
      async (tx) => {
        const context = await this.context(tx, tool, scope);
        return {
          ...context,
          email: context.capability === 'orders.read' ? await this.verifiedEmail(tx, scope) : null,
        };
      },
    ).catch((error: unknown) => {
      throw error instanceof ToolCallFailure ? error : unavailable();
    });
    const call: StoreCall = {
      baseUrl: ctx.connection.baseUrl,
      policy: ctx.policy,
      timeoutMs: tool.timeoutMs,
      signal: options.signal,
    };
    try {
      if (ctx.capability === 'orders.read') {
        const email = ctx.email;
        if (!email) throw notSignedIn();
        const found = (await this.search(ctx.kind, call, ctx.credentials, email)).filter((order) =>
          sameEmail(order.email, email),
        );
        return {
          status: 'succeeded',
          output: { orders: found.map(publicOrder), limit: STORE_ORDER_LIMIT },
          reference: null,
          summary:
            found.length === 0
              ? `No ${PRODUCT[ctx.kind]} orders for this customer.`
              : `${found.length} ${PRODUCT[ctx.kind]} order${found.length === 1 ? '' : 's'} found.`,
        };
      }
      const number = orderNumberOf(args.orderNumber);
      const email = emailOf(args.email);
      if (!number || !email) throw badLookup();
      const order = await this.lookup(ctx.kind, call, ctx.credentials, number);
      // A wrong email reads exactly like an unknown number: the lookup proves nothing else.
      const match = order && sameEmail(order.email, email) ? order : null;
      return {
        status: 'succeeded',
        output: match
          ? { found: true, order: publicOrder(match) }
          : { found: false, message: 'No order with that number and email.' },
        reference: null,
        summary: match ? `Order ${match.number} found.` : 'No order with that number and email.',
      };
    } catch (error) {
      throw failure(ctx.kind, error);
    }
  }

  /** Recent orders placed with this email, newest first. */
  private async search(
    kind: StoreKind,
    call: StoreCall,
    credentials: { key: string; secret: string },
    email: string,
  ): Promise<Found[]> {
    if (kind === 'shopify') {
      const data = await callShopify({
        ...call,
        token: credentials.secret,
        query: 'orders',
        search: `email:"${email}"`,
        first: STORE_ORDER_LIMIT,
      });
      const orders = shopifyOrders(data);
      if (!orders) throw new StoreApiError('response');
      return orders;
    }
    const rows = (await callWooCommerce({
      ...call,
      key: credentials.key,
      secret: credentials.secret,
      read: { kind: 'orders', search: email, perPage: STORE_ORDER_LIMIT },
    })) as unknown[];
    return rows.map(wooOrder).filter((order): order is Found => order !== null);
  }

  /** The order with this number, whoever placed it (the caller compares the email). */
  private async lookup(
    kind: StoreKind,
    call: StoreCall,
    credentials: { key: string; secret: string },
    number: string,
  ): Promise<Found | null> {
    const key = numberKey(number);
    if (kind === 'shopify') {
      const data = await callShopify({
        ...call,
        token: credentials.secret,
        query: 'orders',
        search: `name:"${number}" OR name:"#${number}"`,
        first: 5,
      });
      const orders = shopifyOrders(data);
      if (!orders) throw new StoreApiError('response');
      return orders.find((order) => numberKey(order.number) === key) ?? null;
    }
    const woo = { ...call, key: credentials.key, secret: credentials.secret };
    if (/^\d{1,15}$/.test(number)) {
      const order = wooOrder(
        await callWooCommerce({ ...woo, read: { kind: 'order', id: Number(number) } }),
      );
      if (order && numberKey(order.number) === key) return order;
    }
    // Stores that number orders their own way (a plugin's "NL-1048"): search for the number.
    const rows = (await callWooCommerce({
      ...woo,
      read: { kind: 'orders', search: number, perPage: 5 },
    })) as unknown[];
    return (
      rows
        .map(wooOrder)
        .find((order): order is Found => order !== null && numberKey(order.number) === key) ?? null
    );
  }
}
