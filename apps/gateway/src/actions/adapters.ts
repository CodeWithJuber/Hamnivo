import { checkEgressUrl, EgressError } from '@hamnivo/adapters/egress';
import { callMcpTool, McpCallError } from '@hamnivo/adapters/mcp';
import { DemoActionsStore, DemoToolError } from '@hamnivo/adapters/tools';
import { type Db, schema, type TenantTx, toPublicId, withTenant } from '@hamnivo/db';
import {
  type ContainedOutput,
  containToolOutput,
  type PortableSchema,
  sanitizeToolSchema,
} from '@hamnivo/domain/actions';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { moneyText } from '../commerce/common.js';
import type { AppConfig } from '../config.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CONFIG } from '../tokens.js';

export type ToolRow = typeof schema.toolDefinitions.$inferSelect;

/**
 * The tool's output schema (portable subset): null when the tool has none, `false` when the
 * stored schema cannot be read, which refuses every result instead of passing it unchecked.
 */
function outputSchemaOf(tool: ToolRow): PortableSchema | null | false {
  if (!tool.outputSchema) return null;
  const parsed = sanitizeToolSchema(tool.outputSchema, { trusted: tool.source === 'builtin' });
  return parsed.ok ? parsed.schema : false;
}

/**
 * Contains what a tool returned (X09): the tool's size limit, plain data only, and its output
 * schema when it has one. Used by live runs and by simulations alike.
 */
export function containOutput(tool: ToolRow, output: unknown): ContainedOutput {
  const schema = outputSchemaOf(tool);
  if (schema === false) return { ok: false, reason: 'schema_mismatch', bytes: 0 };
  return containToolOutput(output, { maxBytes: tool.maxOutputBytes, schema });
}

/** Where a tool call happens: the conversation and the customer it is for. */
export interface ToolScope {
  tenantId: string;
  brandId: string;
  conversationId: string;
  /** The customer of the conversation, when Hamnivo knows them. */
  principalId: string | null;
}

export interface ProposedResource {
  type: string;
  id: string;
  label: string;
  /** Approvals bind to it; null for resources without a version. */
  revision: string | null;
}

/** What an action would do, in plain words from Hamnivo's records (never model text). */
export interface Proposal {
  summary: string;
  effects: string[];
  changes: { field: string; from: string | null; to: string }[];
  resource: ProposedResource | null;
  amount: { amountMinor: bigint; currency: string } | null;
}

export type Prepared = { ok: true; proposal: Proposal } | { ok: false; summary: string };

export type ToolOutcome =
  | { status: 'succeeded'; output: unknown; reference: string | null; summary: string }
  | { status: 'failed'; reason: string; summary: string };

/** A tool call that did not answer; `mayHaveApplied` decides between failed and unknown. */
export class ToolCallFailure extends Error {
  override readonly name = 'ToolCallFailure';
  constructor(
    readonly kind: string,
    message: string,
    readonly mayHaveApplied: boolean,
  ) {
    super(message);
  }
}

type Args = Record<string, unknown>;

const PAYMENT_WORDS: Record<string, string> = {
  not_started: 'payment not started',
  requires_action: 'payment waiting for the customer',
  processing: 'payment being processed',
  authorized: 'payment authorised, not yet taken',
  captured: 'paid',
  failed: 'payment failed',
  cancelled: 'payment cancelled',
  unknown: 'payment status being checked',
};

const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''));

/**
 * The tools behind the registry: Hamnivo's own records (`order_status`), the in-memory demo order
 * service, and remote MCP servers through the egress guard. Every call is scoped to the
 * conversation's customer: an order of someone else does not exist for the call.
 */
@Injectable()
export class ToolAdapters {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretBroker,
  ) {}

  /** Demo tools are offered outside production, or where demos are switched on. */
  demoAllowed(): boolean {
    return this.config.NODE_ENV !== 'production' || this.config.TOOLS_ALLOW_DEMO;
  }

  private demo(scope: ToolScope): DemoActionsStore {
    return DemoActionsStore.get(`${scope.tenantId}:${scope.brandId}`);
  }

  private async order(tx: TenantTx, scope: ToolScope, reference: string) {
    if (!scope.principalId) return null;
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(
        and(
          eq(schema.orders.reference, reference),
          eq(schema.orders.brandId, scope.brandId),
          eq(schema.orders.principalId, scope.principalId),
        ),
      );
    return order ?? null;
  }

  /** The action as it would be proposed: its resource, revision, changes and amount. */
  async prepare(tx: TenantTx, tool: ToolRow, args: Args, scope: ToolScope): Promise<Prepared> {
    if (tool.source === 'mcp') {
      return {
        ok: true,
        proposal: {
          summary: tool.title,
          effects: [],
          changes: Object.entries(args).map(([field, value]) => ({
            field,
            from: null,
            to: (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 300),
          })),
          resource: null,
          amount: null,
        },
      };
    }
    const reference = text(args.orderReference);
    switch (tool.builtin) {
      case 'order_status': {
        const order = await this.order(tx, scope, reference);
        if (!order) {
          return { ok: false, summary: `No order ${reference} was found for this customer.` };
        }
        return {
          ok: true,
          proposal: {
            summary: `Look up order ${reference}`,
            effects: [],
            changes: [],
            resource: {
              type: 'order',
              id: toPublicId('order', order.id),
              label: `Order ${reference}`,
              revision: order.updatedAt.toISOString(),
            },
            amount: null,
          },
        };
      }
      case 'demo_update_address': {
        const current = this.demo(scope).address(reference);
        const address = text(args.address);
        return {
          ok: true,
          proposal: {
            summary: `Change the delivery address of order ${reference} to ${address}`,
            effects: [`Order ${reference} will be delivered to the new address.`],
            changes: [{ field: 'Delivery address', from: current.address, to: address }],
            resource: {
              type: 'order',
              id: reference,
              label: `Order ${reference}`,
              revision: current.revision,
            },
            amount: null,
          },
        };
      }
      case 'demo_issue_credit': {
        const amount = BigInt(Number(args.amountMinor));
        const currency = text(args.currency);
        const shown = moneyText(amount, currency);
        return {
          ok: true,
          proposal: {
            summary: `Issue a store credit of ${shown} for order ${reference}`,
            effects: [
              `${shown} is added to the customer’s store credit.`,
              'A credit cannot be taken back automatically.',
            ],
            changes: [{ field: 'Store credit', from: null, to: shown }],
            resource: {
              type: 'order',
              id: reference,
              label: `Order ${reference}`,
              revision: this.demo(scope).address(reference).revision,
            },
            amount: { amountMinor: amount, currency },
          },
        };
      }
      default:
        return { ok: false, summary: 'This tool is not available.' };
    }
  }

  /** The resource's revision now (approvals are rechecked against it). */
  async revision(tx: TenantTx, tool: ToolRow, args: Args, scope: ToolScope) {
    const prepared = await this.prepare(tx, tool, args, scope);
    return prepared.ok ? (prepared.proposal.resource?.revision ?? null) : 'missing';
  }

  private async mcpEndpoint(tool: ToolRow, scope: ToolScope) {
    return withTenant(this.db, { tenantId: scope.tenantId, actorId: 'ai' }, async (tx) => {
      const [server] = await tx
        .select()
        .from(schema.mcpServers)
        .where(eq(schema.mcpServers.id, tool.mcpServerId as string));
      if (server?.status !== 'active') {
        throw new ToolCallFailure('server_disabled', 'The tool’s server is disabled.', false);
      }
      // The tool may reach only the hosts on its own allowlist, its server's included (D10).
      try {
        checkEgressUrl(new URL(server.url), {
          allowedHosts: tool.egressHosts,
          allowPrivate: this.config.TOOLS_EGRESS_ALLOW_PRIVATE,
        });
      } catch (error) {
        if (error instanceof EgressError) throw new ToolCallFailure('egress', error.message, false);
        throw error;
      }
      const token = server.tokenSecretId
        ? await this.secrets.reveal(tx, scope.tenantId, server.tokenSecretId)
        : null;
      return {
        url: server.url,
        token,
        allowedHosts: tool.egressHosts,
        allowPrivate: this.config.TOOLS_EGRESS_ALLOW_PRIVATE,
        timeoutMs: tool.timeoutMs,
        maxResponseBytes: Math.max(tool.maxOutputBytes * 4, 65_536),
      };
    });
  }

  /** Runs the tool once. Throws ToolCallFailure when there is no answer. */
  async execute(
    tool: ToolRow,
    args: Args,
    scope: ToolScope,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<ToolOutcome> {
    if (tool.source === 'mcp') {
      const endpoint = await this.mcpEndpoint(tool, scope);
      try {
        const result = await callMcpTool(endpoint, tool.remoteName as string, args, {
          idempotencyKey: options.idempotencyKey,
          signal: options.signal,
        });
        if (result.isError) {
          return {
            status: 'failed',
            reason: 'tool_error',
            summary: `${tool.title}: the service reported a failure.`,
          };
        }
        return {
          status: 'succeeded',
          output: result.structured ?? (result.text ? result.text : {}),
          reference: null,
          summary: `${tool.title}: completed.`,
        };
      } catch (error) {
        if (error instanceof McpCallError) {
          throw new ToolCallFailure(error.kind, error.message, error.mayHaveApplied);
        }
        throw new ToolCallFailure('unexpected', 'The tool failed.', true);
      }
    }
    const reference = text(args.orderReference);
    try {
      switch (tool.builtin) {
        case 'order_status':
          return await this.orderStatus(scope, reference);
        case 'demo_update_address': {
          const change = await this.demo(scope).updateAddress(
            { reference, address: text(args.address), idempotencyKey: options.idempotencyKey },
            options.signal,
          );
          return {
            status: 'succeeded',
            output: { reference: change.reference, address: change.to },
            reference: change.changeId,
            summary: `The delivery address of order ${reference} is now ${change.to}.`,
          };
        }
        case 'demo_issue_credit': {
          const credit = await this.demo(scope).issueCredit(
            {
              reference,
              amountMinor: String(args.amountMinor),
              currency: text(args.currency),
              idempotencyKey: options.idempotencyKey,
            },
            options.signal,
          );
          return {
            status: 'succeeded',
            output: { reference, creditId: credit.creditId },
            reference: credit.creditId,
            summary: `A store credit of ${moneyText(BigInt(credit.amountMinor), credit.currency)} was issued for order ${reference}.`,
          };
        }
        default:
          return {
            status: 'failed',
            reason: 'unavailable',
            summary: 'This tool is not available.',
          };
      }
    } catch (error) {
      if (error instanceof DemoToolError) {
        throw new ToolCallFailure(error.kind, error.message, error.mayHaveApplied);
      }
      if (error instanceof ToolCallFailure) throw error;
      throw new ToolCallFailure('unexpected', 'The tool failed.', true);
    }
  }

  private async orderStatus(scope: ToolScope, reference: string): Promise<ToolOutcome> {
    return withTenant(this.db, { tenantId: scope.tenantId, actorId: 'ai' }, async (tx) => {
      const order = await this.order(tx, scope, reference);
      if (!order) {
        return {
          status: 'failed',
          reason: 'not_found',
          summary: `No order ${reference} was found for this customer.`,
        };
      }
      const [fulfillment] = await tx
        .select()
        .from(schema.fulfillments)
        .where(eq(schema.fulfillments.orderId, order.id))
        .orderBy(desc(schema.fulfillments.updatedAt))
        .limit(1);
      const payment = PAYMENT_WORDS[order.paymentState] ?? order.paymentState;
      const delivery = (fulfillment?.state ?? order.fulfillmentState).replace(/_/g, ' ');
      const estimate = fulfillment?.estimateAt?.toISOString().slice(0, 10) ?? null;
      return {
        status: 'succeeded',
        output: {
          reference: order.reference,
          payment,
          delivery,
          total: moneyText(order.totalMinor, order.currency),
          placedAt: order.placedAt.toISOString(),
          estimate,
        },
        reference: order.reference,
        summary: `Order ${order.reference}: ${payment}; delivery ${delivery}${
          estimate ? `, the shop estimates ${estimate}` : ''
        }.`,
      };
    });
  }

  /**
   * What happened to a call whose answer was lost, from the tool's own records. Null when the
   * tool cannot say (MCP servers have no standard lookup): a person checks and records it.
   */
  async reconcile(
    tool: ToolRow,
    args: Args,
    scope: ToolScope,
    idempotencyKey: string,
  ): Promise<ToolOutcome | null> {
    if (tool.source !== 'builtin' || tool.builtin === 'order_status') return null;
    const applied = this.demo(scope).lookup(idempotencyKey);
    const reference = text(args.orderReference);
    if (!applied) {
      return {
        status: 'failed',
        reason: 'not_applied',
        summary: `The change for order ${reference} was not made.`,
      };
    }
    if (applied.kind === 'address') {
      return {
        status: 'succeeded',
        output: { reference, address: applied.result.to },
        reference: applied.result.changeId,
        summary: `The delivery address of order ${reference} is now ${applied.result.to}.`,
      };
    }
    return {
      status: 'succeeded',
      output: { reference, creditId: applied.result.creditId },
      reference: applied.result.creditId,
      summary: `A store credit of ${moneyText(BigInt(applied.result.amountMinor), applied.result.currency)} was issued for order ${reference}.`,
    };
  }
}
