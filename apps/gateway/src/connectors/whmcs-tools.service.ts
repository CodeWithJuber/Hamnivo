import { createHash } from 'node:crypto';
import { hostAllowed } from '@hamnivo/adapters/net';
import { callWhmcs, type WhmcsAction, WhmcsApiError } from '@hamnivo/adapters/whmcs';
import { type Db, newId, schema, type TenantTx, withTenant } from '@hamnivo/db';
import {
  hasWhmcsPermission,
  ownedByWhmcsClient,
  WHMCS_SPEC,
  whmcsCapability,
  whmcsPublicFields,
} from '@hamnivo/domain/connectors';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Prepared, ToolOutcome, ToolRow, ToolScope } from '../actions/adapters.js';
import { EgressService } from '../developer/egress.service.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { ToolCallFailure } from './tool-call-failure.js';

type Args = Record<string, unknown>;
type Json = Record<string, unknown>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = () =>
  new ToolCallFailure(
    'whmcs_denied',
    'WHMCS access, ownership or the live quote could not be verified. Sign in again or ask staff to review.',
    false,
  );
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw denied();
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw denied();
  return value;
}
function rows(result: Json, outer: string, inner: string): Json[] {
  const container = result[outer];
  if (!container || typeof container !== 'object') {
    if (Number(result.totalresults) === 0) return [];
    throw denied();
  }
  const entries = (container as Json)[inner];
  if (
    !Array.isArray(entries) ||
    entries.some((x) => !x || typeof x !== 'object' || Array.isArray(x))
  )
    throw denied();
  return entries as Json[];
}
const FIELDS = {
  invoices: ['id', 'invoicenum', 'date', 'duedate', 'total', 'balance', 'status', 'currencycode'],
  services: [
    'id',
    'pid',
    'name',
    'domain',
    'status',
    'billingcycle',
    'nextduedate',
    'recurringamount',
  ],
  domains: [
    'id',
    'domainname',
    'status',
    'registrationdate',
    'expirydate',
    'nextduedate',
    'recurringamount',
  ],
  tickets: ['id', 'tid', 'subject', 'status', 'priority', 'date', 'lastreply'],
} as const;

@Injectable()
export class WhmcsTools {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
  ) {}

  /** Every proposal, approval check and dispatch rechecks a live user/client association. */
  private async context(tx: TenantTx, tool: ToolRow, scope: ToolScope, signal?: AbortSignal) {
    if (
      !scope.principalId ||
      tool.brandId !== scope.brandId ||
      !whmcsCapability(tool.remoteName ?? '')
    )
      throw denied();
    const capability = tool.remoteName as keyof typeof WHMCS_SPEC;
    const spec = WHMCS_SPEC[capability];
    if (
      tool.status !== 'enabled' ||
      tool.risk !== spec.risk ||
      tool.approver !== spec.approver ||
      (spec.risk !== 'read' && tool.autopilot) ||
      (spec.risk !== 'read' && spec.approver === 'customer' && !tool.customerStepUp)
    )
      throw denied();
    const [grant] = await tx
      .select()
      .from(schema.connectorToolGrants)
      .where(
        and(
          eq(schema.connectorToolGrants.toolId, tool.id),
          eq(schema.connectorToolGrants.enabled, 'yes'),
        ),
      );
    if (!grant || grant.capability !== capability) throw denied();
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
      grant.version !== connection.grantVersion ||
      !hostAllowed(new URL(connection.baseUrl).hostname, tool.egressHosts)
    )
      throw denied();
    if (connection.kind !== 'whmcs' || !connection.identityKeyId) throw denied();
    const [key] = await tx
      .select()
      .from(schema.brandIdentityKeys)
      .where(eq(schema.brandIdentityKeys.id, connection.identityKeyId));
    if (!key || key.status === 'revoked') throw denied();
    const [binding] = await tx
      .select()
      .from(schema.connectorIdentityBindings)
      .where(
        and(
          eq(schema.connectorIdentityBindings.connectionId, connection.id),
          eq(schema.connectorIdentityBindings.brandId, scope.brandId),
          eq(schema.connectorIdentityBindings.principalId, scope.principalId),
        ),
      );
    if (!binding || binding.expiresAt <= this.clock()) throw denied();
    if (!connection.identifierSecretId) throw denied();
    const credentials = {
      identifier: await this.secrets.reveal(tx, scope.tenantId, connection.identifierSecretId),
      secret: await this.secrets.reveal(tx, scope.tenantId, connection.tokenSecretId),
    };
    const policy = await this.egress.policyIn(tx, []);
    const call = (action: WhmcsAction, fields: Record<string, string | number | boolean> = {}) =>
      callWhmcs({
        baseUrl: connection.baseUrl,
        credentials,
        policy,
        action,
        fields,
        timeoutMs: tool.timeoutMs,
        ...(signal ? { signal } : {}),
      });
    const permissions = await call('GetUserPermissions', {
      user_id: binding.userId,
      client_id: binding.clientId,
    });
    if (!hasWhmcsPermission(permissions, WHMCS_SPEC[capability].permission)) throw denied();
    return { capability, connection, binding, call };
  }

  /** Network inspection may yield to local revocation. Reserve only against locked live state. */
  private async revalidateBeforeDispatch(
    tx: TenantTx,
    tool: ToolRow,
    scope: ToolScope,
    inspected: Awaited<ReturnType<WhmcsTools['inspect']>>,
  ): Promise<void> {
    const [connection] = await tx
      .select()
      .from(schema.connectorConnections)
      .where(eq(schema.connectorConnections.id, inspected.connection.id))
      .for('update');
    if (
      connection?.status !== 'active' ||
      connection.brandId !== scope.brandId ||
      connection.grantVersion !== inspected.connection.grantVersion ||
      connection.identityKeyId !== inspected.connection.identityKeyId ||
      connection.baseUrl !== inspected.connection.baseUrl ||
      connection.identifierSecretId !== inspected.connection.identifierSecretId ||
      connection.tokenSecretId !== inspected.connection.tokenSecretId
    )
      throw denied();
    const [grant] = await tx
      .select()
      .from(schema.connectorToolGrants)
      .where(
        and(
          eq(schema.connectorToolGrants.connectionId, connection.id),
          eq(schema.connectorToolGrants.toolId, tool.id),
        ),
      )
      .for('share');
    if (
      grant?.enabled !== 'yes' ||
      grant.capability !== inspected.capability ||
      grant.version !== connection.grantVersion ||
      !connection.identityKeyId
    )
      throw denied();
    const [key] = await tx
      .select()
      .from(schema.brandIdentityKeys)
      .where(eq(schema.brandIdentityKeys.id, connection.identityKeyId))
      .for('share');
    if (!key || key.status === 'revoked') throw denied();
    const [binding] = await tx
      .select()
      .from(schema.connectorIdentityBindings)
      .where(
        and(
          eq(schema.connectorIdentityBindings.connectionId, connection.id),
          eq(schema.connectorIdentityBindings.brandId, scope.brandId),
          eq(schema.connectorIdentityBindings.principalId, scope.principalId!),
        ),
      )
      .for('share');
    if (
      !binding ||
      binding.expiresAt <= this.clock() ||
      binding.userId !== inspected.binding.userId ||
      binding.clientId !== inspected.binding.clientId
    )
      throw denied();
    const [currentTool] = await tx
      .select()
      .from(schema.toolDefinitions)
      .where(eq(schema.toolDefinitions.id, tool.id))
      .for('share');
    if (
      currentTool?.status !== 'enabled' ||
      currentTool.source !== 'native' ||
      currentTool.brandId !== scope.brandId ||
      currentTool.revision !== tool.revision ||
      currentTool.remoteName !== inspected.capability ||
      currentTool.risk !== tool.risk ||
      currentTool.approver !== tool.approver ||
      currentTool.autopilot !== tool.autopilot ||
      currentTool.customerStepUp !== tool.customerStepUp ||
      !hostAllowed(new URL(connection.baseUrl).hostname, currentTool.egressHosts) ||
      binding.expiresAt <= this.clock()
    )
      throw denied();
  }

  private upgradeArgs(args: Args) {
    const cycle = string(args.billingCycle, 30);
    if (
      !['monthly', 'quarterly', 'semiannually', 'annually', 'biennially', 'triennially'].includes(
        cycle,
      )
    )
      throw denied();
    return {
      serviceid: positive(args.serviceId),
      newproductid: positive(args.newProductId),
      newproductbillingcycle: cycle,
      paymentmethod: string(args.paymentMethod, 50),
      type: 'product',
    };
  }

  private async inspect(
    tx: TenantTx,
    tool: ToolRow,
    args: Args,
    scope: ToolScope,
    signal?: AbortSignal,
  ) {
    const ctx = await this.context(tx, tool, scope, signal);
    const { capability, call, binding } = ctx;
    let resource: Json = { clientid: binding.clientId };
    let price: string | null = null;
    let quote: typeof schema.connectorQuotes.$inferSelect | null = null;
    if (capability === 'invoice.payment_url' || capability === 'refund.handoff') {
      resource = await call('GetInvoice', { invoiceid: positive(args.invoiceId) });
      if (!ownedByWhmcsClient(resource, binding.clientId)) throw denied();
      resource = whmcsPublicFields(resource, [
        'invoiceid',
        'userid',
        'status',
        'total',
        'balance',
        'date',
        'duedate',
      ]);
    } else if (capability === 'tickets.reply') {
      resource = await call('GetTicket', { ticketid: positive(args.ticketId) });
      if (!ownedByWhmcsClient(resource, binding.clientId)) throw denied();
      resource = whmcsPublicFields(resource, ['ticketid', 'userid', 'status', 'lastreply']);
      string(args.message, 4000);
    } else if (capability.startsWith('upgrade.') || capability === 'cancellation.request') {
      const result = await call('GetClientsProducts', {
        clientid: binding.clientId,
        serviceid: positive(args.serviceId),
        limitnum: 1,
      });
      const service = rows(result, 'products', 'product').find(
        (x) => Number(x.id) === args.serviceId,
      );
      if (!service || !ownedByWhmcsClient({ ...service, result: 'success' }, binding.clientId))
        throw denied();
      resource = whmcsPublicFields(service, [
        'id',
        'clientid',
        'pid',
        'status',
        'billingcycle',
        'nextduedate',
        'recurringamount',
      ]);
      if (capability.startsWith('upgrade.')) {
        const calculated = await call('UpgradeProduct', {
          ...this.upgradeArgs(args),
          calconly: true,
        });
        if (
          calculated.upgradeinprogress === true ||
          calculated.upgradeinprogress === 1 ||
          calculated.upgradeinprogress === '1'
        )
          throw denied();
        price = string(calculated.price, 120);
        if (capability === 'upgrade.request') {
          const quoteId = string(args.quoteId, 100);
          if (!/^[0-9a-f-]{36}$/.test(quoteId)) throw denied();
          const [saved] = await tx
            .select()
            .from(schema.connectorQuotes)
            .where(
              and(
                eq(schema.connectorQuotes.id, quoteId),
                eq(schema.connectorQuotes.connectionId, ctx.connection.id),
                eq(schema.connectorQuotes.principalId, scope.principalId!),
                eq(schema.connectorQuotes.conversationId, scope.conversationId),
              ),
            );
          if (
            !saved ||
            saved.consumedAt ||
            saved.expiresAt <= this.clock() ||
            saved.price !== price ||
            saved.fingerprint !==
              digest({ args: this.upgradeArgs(args), resource, grant: ctx.connection.grantVersion })
          )
            throw denied();
          quote = saved;
        }
      } else if (!['Immediate', 'End of Billing Period'].includes(String(args.type)))
        throw denied();
    } else if (capability === 'tickets.create') {
      positive(args.departmentId);
      string(args.subject, 200);
      string(args.message, 4000);
    }
    return { ...ctx, resource, price, quote };
  }

  async prepare(tx: TenantTx, tool: ToolRow, args: Args, scope: ToolScope): Promise<Prepared> {
    try {
      const ctx = await this.inspect(tx, tool, args, scope);
      const spec = WHMCS_SPEC[ctx.capability];
      const changes = Object.entries(args).map(([field, value]) => ({
        field,
        from: null,
        to: String(value).slice(0, 4000),
      }));
      if (ctx.price) changes.push({ field: 'Live upgrade price', from: null, to: ctx.price });
      return {
        ok: true,
        proposal: {
          summary: spec.title,
          effects: [spec.description],
          changes,
          amount: null,
          resource: {
            type: 'whmcs',
            id: `${ctx.connection.id}:${ctx.binding.clientId}:${args.serviceId ?? args.invoiceId ?? args.ticketId ?? 'account'}`,
            label: `WHMCS client ${ctx.binding.clientId}`,
            revision: digest({
              grant: ctx.connection.grantVersion,
              resource: ctx.resource,
              price: ctx.price,
            }),
          },
        },
      };
    } catch {
      return { ok: false, summary: denied().message };
    }
  }

  private async dispatchState(tenantId: string, id: string, state: 'confirmed' | 'rejected') {
    await withTenant(this.db, { tenantId, actorId: 'ai' }, (tx) =>
      tx
        .update(schema.connectorDispatches)
        .set({ state })
        .where(eq(schema.connectorDispatches.id, id)),
    );
  }

  async execute(
    tool: ToolRow,
    args: Args,
    scope: ToolScope,
    options: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<ToolOutcome> {
    let dispatchId: string | null = null;
    try {
      // Commit quote consumption before dispatch: uncertainty can never make the quote reusable.
      const ctx = await withTenant(
        this.db,
        { tenantId: scope.tenantId, actorId: 'ai' },
        async (tx) => {
          const inspected = await this.inspect(tx, tool, args, scope, options.signal);
          if (inspected.binding.expiresAt <= this.clock()) throw denied();
          if (
            ['tickets.create', 'tickets.reply', 'upgrade.request', 'cancellation.request'].includes(
              inspected.capability,
            )
          ) {
            await this.revalidateBeforeDispatch(tx, tool, scope, inspected);
            // Scope to the remote client, not the acting user: another authorized user cannot
            // accidentally repeat an uncertain write for the same account.
            const fingerprint = digest({
              capability: inspected.capability,
              clientId: inspected.binding.clientId,
              args: Object.fromEntries(
                Object.entries(args)
                  .filter(([key]) => key !== 'quoteId')
                  .sort(([a], [b]) => a.localeCompare(b)),
              ),
            });
            const [unresolved] = await tx
              .select()
              .from(schema.connectorDispatches)
              .where(
                and(
                  eq(schema.connectorDispatches.connectionId, inspected.connection.id),
                  eq(schema.connectorDispatches.fingerprint, fingerprint),
                  eq(schema.connectorDispatches.state, 'dispatched'),
                ),
              );
            if (unresolved) {
              const [operation] = await tx
                .select()
                .from(schema.operations)
                .where(eq(schema.operations.providerIdempotencyKey, unresolved.idempotencyKey));
              // Only the existing audited manual-reconciliation flow can settle uncertainty.
              if (operation?.state !== 'succeeded' && operation?.state !== 'failed') {
                throw new ToolCallFailure(
                  'whmcs_unknown',
                  'An earlier matching WHMCS request has an unknown outcome. Staff must verify it in WHMCS; it will not be resent.',
                  false,
                );
              }
              await tx
                .update(schema.connectorDispatches)
                .set({ state: operation.state === 'succeeded' ? 'confirmed' : 'rejected' })
                .where(eq(schema.connectorDispatches.id, unresolved.id));
            }
            dispatchId = newId();
            await tx.insert(schema.connectorDispatches).values({
              id: dispatchId,
              tenantId: scope.tenantId,
              connectionId: inspected.connection.id,
              principalId: scope.principalId!,
              fingerprint,
              idempotencyKey: options.idempotencyKey,
              state: 'dispatched',
            });
          }
          if (inspected.quote) {
            const [claimed] = await tx
              .update(schema.connectorQuotes)
              .set({ consumedAt: this.clock() })
              .where(
                and(
                  eq(schema.connectorQuotes.id, inspected.quote.id),
                  isNull(schema.connectorQuotes.consumedAt),
                  gt(schema.connectorQuotes.expiresAt, this.clock()),
                ),
              )
              .returning();
            if (!claimed) throw denied();
          }
          return inspected;
        },
      );
      const { capability, call, binding } = ctx;
      let output: unknown;
      let reference: string | null = null;
      if (['invoices.read', 'services.read', 'domains.read', 'tickets.read'].includes(capability)) {
        const definition = {
          'invoices.read': ['GetInvoices', 'invoices', 'invoice', 'invoices'],
          'services.read': ['GetClientsProducts', 'products', 'product', 'services'],
          'domains.read': ['GetClientsDomains', 'domains', 'domain', 'domains'],
          'tickets.read': ['GetTickets', 'tickets', 'ticket', 'tickets'],
        }[capability as 'invoices.read' | 'services.read' | 'domains.read' | 'tickets.read'] as [
          WhmcsAction,
          string,
          string,
          keyof typeof FIELDS,
        ];
        const result = await call(definition[0], { clientid: binding.clientId, limitnum: 25 });
        const items = rows(result, definition[1], definition[2]);
        if (
          items.some(
            (item) => !ownedByWhmcsClient({ ...item, result: 'success' }, binding.clientId),
          )
        )
          throw denied();
        output = {
          items: items.map((item) => whmcsPublicFields(item, FIELDS[definition[3]])),
          limit: 25,
        };
      } else if (capability === 'invoice.payment_url') {
        const url = new URL('viewinvoice.php', ctx.connection.baseUrl);
        url.searchParams.set('id', String(positive(args.invoiceId)));
        output = { invoiceId: args.invoiceId, url: url.toString(), requiresWhmcsSignIn: true };
      } else if (capability === 'refund.handoff') {
        output = {
          status: 'manual_review_required',
          invoiceId: args.invoiceId,
          reason: string(args.reason, 1000),
          invoice: ctx.resource,
          message:
            'Staff must review and process any refund in WHMCS or the payment provider. No refund was issued.',
        };
      } else if (capability === 'upgrade.quote') {
        const expiresAt = new Date(this.clock().getTime() + 300000);
        const id = newId();
        await withTenant(this.db, { tenantId: scope.tenantId, actorId: 'ai' }, (tx) =>
          tx.insert(schema.connectorQuotes).values({
            id,
            tenantId: scope.tenantId,
            connectionId: ctx.connection.id,
            principalId: scope.principalId!,
            conversationId: scope.conversationId,
            price: ctx.price!,
            fingerprint: digest({
              args: this.upgradeArgs(args),
              resource: ctx.resource,
              grant: ctx.connection.grantVersion,
            }),
            expiresAt,
          }),
        );
        output = {
          quoteId: id,
          price: ctx.price,
          expiresAt: expiresAt.toISOString(),
          requiresStaffApproval: true,
        };
      } else {
        let result: Json;
        if (capability === 'tickets.create')
          result = await call('OpenTicket', {
            clientid: binding.clientId,
            userid: binding.userId,
            deptid: positive(args.departmentId),
            subject: string(args.subject, 200),
            message: string(args.message, 4000),
            markdown: false,
          });
        else if (capability === 'tickets.reply')
          result = await call('AddTicketReply', {
            clientid: binding.clientId,
            ticketid: positive(args.ticketId),
            message: string(args.message, 4000),
            markdown: false,
          });
        else if (capability === 'upgrade.request')
          result = await call('UpgradeProduct', this.upgradeArgs(args));
        else if (capability === 'cancellation.request')
          result = await call('AddCancelRequest', {
            serviceid: positive(args.serviceId),
            type: String(args.type),
            reason: args.reason === undefined ? '' : string(args.reason, 1000),
          });
        else throw denied();
        output = whmcsPublicFields(result, ['result', 'id', 'tid', 'orderid', 'invoiceid']);
        reference =
          result.id !== undefined
            ? String(result.id)
            : result.orderid !== undefined
              ? String(result.orderid)
              : null;
      }
      if (dispatchId) await this.dispatchState(scope.tenantId, dispatchId, 'confirmed');
      return {
        status: 'succeeded',
        output,
        reference,
        summary:
          capability === 'refund.handoff'
            ? 'Refund handoff prepared; no refund was issued.'
            : `${WHMCS_SPEC[capability].title}: completed.`,
      };
    } catch (error) {
      if (dispatchId && error instanceof WhmcsApiError && !error.mayHaveApplied)
        await this.dispatchState(scope.tenantId, dispatchId, 'rejected');
      if (error instanceof WhmcsApiError)
        throw new ToolCallFailure(`whmcs_${error.kind}`, error.message, error.mayHaveApplied);
      if (error instanceof ToolCallFailure) throw error;
      throw new ToolCallFailure(
        'whmcs_unavailable',
        'WHMCS could not be checked.',
        dispatchId !== null,
      );
    }
  }
}
