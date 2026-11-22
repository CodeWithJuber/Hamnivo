import { checkDestination, EgressError, type EgressPolicy } from '@hamnivo/adapters/net';
import type {
  CreatedWebhookEndpoint,
  CreateWebhookEndpointRequest,
  RotatedWebhookSecret,
  RotateWebhookSecretRequest,
  TestWebhookResult,
  UpdateWebhookEndpointRequest,
  WebhookEndpoint,
  WebhookEventType,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { EntitlementsService } from '../../billing/entitlements.service.js';
import { AppError } from '../../common/app-error.js';
import type { AppConfig } from '../../config.js';
import { SecretBroker } from '../../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../../tokens.js';
import { EgressService } from '../egress.service.js';
import { leaseSeconds } from './delivery-rules.js';
import { WebhookFanout } from './fanout.service.js';
import { type EndpointRow, SIGNING_SECRET_KIND, WebhookSender } from './sender.service.js';
import { generateSigningSecret } from './signing.js';
import { attemptView, deliveryView } from './views.js';

const HOUR = 3_600_000;

function urlProblem(error: EgressError): string {
  switch (error.problem) {
    case 'insecure_url':
      return 'Use an https:// address.';
    case 'host_not_allowed':
      return 'This host is not on the list of allowed hosts. Add it under Allowed hosts first.';
    case 'private_address':
      return 'This address points to a private or local network, which Hamnivo never calls.';
    default:
      return 'Enter the full address of your endpoint, starting with https://.';
  }
}

/**
 * Webhook endpoints (D06): HTTPS addresses a tenant registers with the event types they want.
 * Each has its own `whsec_` signing secret in the secret broker; the plain secret appears only in
 * the response that creates or rotates it. Every change is audited without the secret.
 */
@Injectable()
export class WebhookEndpointsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretBroker,
    private readonly egress: EgressService,
    private readonly sender: WebhookSender,
    private readonly fanout: WebhookFanout,
    private readonly entitlements: EntitlementsService,
  ) {}

  private staffTx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  parseId(publicId: string): string {
    try {
      return fromPublicId('webhookEndpoint', publicId);
    } catch {
      throw new AppError('NOT_FOUND', { detail: 'Webhook endpoint not found.' });
    }
  }

  /** Views of endpoints with their secret hint, health and latest delivery. */
  async views(tx: TenantTx, endpointId?: string): Promise<WebhookEndpoint[]> {
    const e = schema.webhookEndpoints;
    const rows = await tx
      .select({ endpoint: e, hint: schema.secrets.hint })
      .from(e)
      .leftJoin(schema.secrets, eq(schema.secrets.id, e.secretId))
      .where(endpointId ? eq(e.id, endpointId) : undefined)
      .orderBy(asc(e.createdAt));
    if (rows.length === 0) return [];
    const d = schema.webhookDeliveries;
    const latest = await tx
      .selectDistinctOn([d.endpointId], {
        endpointId: d.endpointId,
        id: d.id,
        status: d.status,
        lastStatusCode: d.lastStatusCode,
        createdAt: d.createdAt,
        lastAttemptAt: d.lastAttemptAt,
        type: schema.webhookEvents.type,
      })
      .from(d)
      .innerJoin(schema.webhookEvents, eq(schema.webhookEvents.id, d.eventId))
      .where(
        inArray(
          d.endpointId,
          rows.map((row) => row.endpoint.id),
        ),
      )
      .orderBy(d.endpointId, desc(d.createdAt));
    const latestBy = new Map(latest.map((row) => [row.endpointId, row]));
    const policy = await this.egress.policyIn(tx);
    return rows.map(({ endpoint, hint }) =>
      this.view(endpoint, hint ?? '', latestBy.get(endpoint.id), policy),
    );
  }

  private view(
    endpoint: EndpointRow,
    hint: string,
    latest:
      | {
          id: string;
          status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
          lastStatusCode: number | null;
          createdAt: Date;
          lastAttemptAt: Date | null;
          type: string;
        }
      | undefined,
    policy: EgressPolicy,
  ): WebhookEndpoint {
    const now = this.clock();
    const previousValid =
      endpoint.previousSecretId &&
      endpoint.previousSecretExpiresAt &&
      endpoint.previousSecretExpiresAt > now
        ? endpoint.previousSecretExpiresAt.toISOString()
        : null;
    return {
      id: toPublicId('webhookEndpoint', endpoint.id),
      url: endpoint.url,
      description: endpoint.description,
      eventTypes: endpoint.eventTypes as WebhookEventType[],
      status:
        endpoint.status === 'disabled'
          ? 'disabled'
          : endpoint.consecutiveFailures > 0
            ? 'failing'
            : 'active',
      disabledReason: endpoint.disabledReason,
      disabledAt: endpoint.disabledAt?.toISOString() ?? null,
      verifiedAt: endpoint.verifiedAt?.toISOString() ?? null,
      secret: {
        hint,
        rotatedAt: endpoint.secretRotatedAt?.toISOString() ?? null,
        previousValidUntil: previousValid,
      },
      health: {
        consecutiveFailures: endpoint.consecutiveFailures,
        failingSince: endpoint.failingSince?.toISOString() ?? null,
        lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null,
        lastFailureAt: endpoint.lastFailureAt?.toISOString() ?? null,
      },
      blockedByAllowlist: !this.egress.allows(policy, endpoint.url),
      latestDelivery: latest
        ? {
            id: toPublicId('webhookDelivery', latest.id),
            eventType: latest.type as WebhookEventType,
            status: latest.status,
            lastStatusCode: latest.lastStatusCode,
            at: (latest.lastAttemptAt ?? latest.createdAt).toISOString(),
          }
        : null,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
      version: endpoint.version,
    };
  }

  async list(tenantId: string): Promise<WebhookEndpoint[]> {
    return withTenant(this.db, { tenantId }, (tx) => this.views(tx));
  }

  async get(tenantId: string, publicId: string): Promise<WebhookEndpoint> {
    const id = this.parseId(publicId);
    return withTenant(this.db, { tenantId }, async (tx) => {
      const [view] = await this.views(tx, id);
      if (!view) throw new AppError('NOT_FOUND', { detail: 'Webhook endpoint not found.' });
      return view;
    });
  }

  /**
   * Checks an address against the SSRF rules and the allowlist, and resolves it once so a name
   * that points inside a private network is refused at once. A name that does not resolve yet is
   * accepted: deliveries check the address again on every connection.
   */
  private async checkAddress(policy: EgressPolicy, url: string): Promise<string> {
    try {
      const destination = await checkDestination(url, policy);
      return destination.url.toString();
    } catch (error) {
      if (!(error instanceof EgressError)) throw error;
      if (error.problem === 'unresolvable') return new URL(url).toString();
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'url', message: urlProblem(error) }],
      });
    }
  }

  private async load(tx: TenantTx, id: string, lock = false): Promise<EndpointRow> {
    const query = tx
      .select()
      .from(schema.webhookEndpoints)
      .where(eq(schema.webhookEndpoints.id, id));
    const [row] = await (lock ? query.for('update') : query);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'Webhook endpoint not found.' });
    return row;
  }

  private audit(
    tx: TenantTx,
    principal: StaffPrincipal,
    action: string,
    endpointId: string,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', principal.staffMemberId),
      action,
      targetType: 'webhook_endpoint',
      targetId: toPublicId('webhookEndpoint', endpointId),
      outcome: 'success',
      data,
    });
  }

  private storeSecret(tx: TenantTx, tenantId: string, url: string, value: string) {
    return this.secrets.storeIn(tx, tenantId, {
      kind: SIGNING_SECRET_KIND,
      label: `Webhook signing secret for ${new URL(url).host}`,
      value,
    });
  }

  async create(
    principal: StaffPrincipal,
    input: z.output<typeof CreateWebhookEndpointRequest>,
  ): Promise<CreatedWebhookEndpoint> {
    return this.staffTx(principal, async (tx) => {
      const url = await this.checkAddress(await this.egress.policyIn(tx), input.url);
      await this.entitlements.assertCapacity(tx, principal.tenantId, 'webhookEndpoints');
      const signingSecret = generateSigningSecret();
      const secretId = await this.storeSecret(tx, principal.tenantId, url, signingSecret);
      const id = newId();
      const eventTypes = [...new Set(input.eventTypes)];
      await tx.insert(schema.webhookEndpoints).values({
        id,
        tenantId: principal.tenantId,
        url,
        description: input.description || null,
        eventTypes,
        secretId,
        createdBy: principal.staffMemberId,
      });
      await this.audit(tx, principal, 'webhook.endpoint_created', id, { url, eventTypes });
      const [view] = await this.views(tx, id);
      if (!view) throw new Error('webhook endpoint not stored');
      return { ...view, signingSecret };
    });
  }

  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof UpdateWebhookEndpointRequest>,
  ): Promise<WebhookEndpoint> {
    const id = this.parseId(publicId);
    return this.staffTx(principal, async (tx) => {
      const current = await this.load(tx, id, true);
      if (current.version !== input.version) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'This endpoint changed since you opened it. Reload and try again.',
        });
      }
      const changes: Partial<typeof schema.webhookEndpoints.$inferInsert> = {};
      const changed: string[] = [];
      if (input.url !== undefined && input.url !== current.url) {
        changes.url = await this.checkAddress(await this.egress.policyIn(tx), input.url);
        // A new address has not answered a test yet.
        changes.verifiedAt = null;
        changed.push('url');
      }
      if (input.description !== undefined) {
        changes.description = input.description || null;
        changed.push('description');
      }
      if (input.eventTypes !== undefined) {
        changes.eventTypes = [...new Set(input.eventTypes)];
        changed.push('eventTypes');
      }
      if (input.status === 'active' && current.status === 'disabled') {
        Object.assign(changes, {
          status: 'active' as const,
          disabledReason: null,
          disabledAt: null,
          consecutiveFailures: 0,
          failingSince: null,
        });
        changed.push('status');
      }
      if (input.status === 'disabled' && current.status === 'active') {
        await this.sender.disable(tx, current, 'manual', {
          type: 'staff',
          id: toPublicId('staff', principal.staffMemberId),
        });
        changed.push('status');
      }
      const now = this.clock();
      if (Object.keys(changes).length > 0) {
        await tx
          .update(schema.webhookEndpoints)
          .set({ ...changes, updatedAt: now, version: sql`${schema.webhookEndpoints.version} + 1` })
          .where(eq(schema.webhookEndpoints.id, id));
      }
      if (changed.length > 0) {
        await this.audit(tx, principal, 'webhook.endpoint_updated', id, {
          changed,
          ...(changes.url ? { url: changes.url } : {}),
          ...(changes.eventTypes ? { eventTypes: changes.eventTypes } : {}),
          ...(input.status && changed.includes('status') ? { status: input.status } : {}),
        });
      }
      const [view] = await this.views(tx, id);
      if (!view) throw new AppError('NOT_FOUND');
      return view;
    });
  }

  /** Removes the endpoint with its deliveries and revokes its signing secrets. */
  async remove(principal: StaffPrincipal, publicId: string): Promise<void> {
    const id = this.parseId(publicId);
    await this.staffTx(principal, async (tx) => {
      const endpoint = await this.load(tx, id, true);
      await tx.delete(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.id, id));
      const secretIds = [endpoint.secretId, endpoint.previousSecretId].filter(
        (value): value is string => Boolean(value),
      );
      await tx
        .update(schema.secrets)
        .set({ revokedAt: this.clock() })
        .where(
          and(inArray(schema.secrets.id, secretIds), sql`${schema.secrets.revokedAt} is null`),
        );
      await this.audit(tx, principal, 'webhook.endpoint_deleted', id, { url: endpoint.url });
    });
  }

  /**
   * A new signing secret. During the overlap requests carry two signatures, one per secret, so
   * receivers can switch without missing an event (Standard Webhooks allows several).
   */
  async rotateSecret(
    principal: StaffPrincipal,
    publicId: string,
    input: z.output<typeof RotateWebhookSecretRequest>,
  ): Promise<RotatedWebhookSecret> {
    const id = this.parseId(publicId);
    return this.staffTx(principal, async (tx) => {
      const endpoint = await this.load(tx, id, true);
      const now = this.clock();
      const signingSecret = generateSigningSecret();
      const secretId = await this.storeSecret(tx, principal.tenantId, endpoint.url, signingSecret);
      // The secret before the previous one stops now; only one older secret ever signs.
      const retired = [
        endpoint.previousSecretId,
        input.overlapHours === 0 ? endpoint.secretId : null,
      ].filter((value): value is string => Boolean(value));
      if (retired.length > 0) {
        await tx
          .update(schema.secrets)
          .set({ revokedAt: now })
          .where(
            and(inArray(schema.secrets.id, retired), sql`${schema.secrets.revokedAt} is null`),
          );
      }
      const overlapEnds =
        input.overlapHours === 0 ? null : new Date(now.getTime() + input.overlapHours * HOUR);
      await tx
        .update(schema.webhookEndpoints)
        .set({
          secretId,
          previousSecretId: overlapEnds ? endpoint.secretId : null,
          previousSecretExpiresAt: overlapEnds,
          secretRotatedAt: now,
          updatedAt: now,
          version: sql`${schema.webhookEndpoints.version} + 1`,
        })
        .where(eq(schema.webhookEndpoints.id, id));
      await this.audit(tx, principal, 'webhook.secret_rotated', id, {
        overlapHours: input.overlapHours,
        previousValidUntil: overlapEnds?.toISOString() ?? null,
      });
      const [view] = await this.views(tx, id);
      if (!view) throw new AppError('NOT_FOUND');
      return { endpoint: view, signingSecret };
    });
  }

  /**
   * Sends a signed `webhook.test` event now and records it like any delivery (one attempt, no
   * retries, the endpoint's failure count untouched). A 2xx answer marks the endpoint verified.
   * Works on a disabled endpoint, so it can be checked before deliveries are turned on again.
   */
  async test(principal: StaffPrincipal, publicId: string): Promise<TestWebhookResult> {
    const id = this.parseId(publicId);
    const prepared = await this.staffTx(principal, async (tx) => {
      const endpoint = await this.load(tx, id);
      const queued = await this.fanout.enqueue(
        tx,
        principal.tenantId,
        `test:${newId()}`,
        {
          type: 'webhook.test',
          occurredAt: this.clock(),
          data: {
            endpointId: toPublicId('webhookEndpoint', id),
            message: 'A test event from Hamnivo. Answer with any 2xx status to confirm.',
          },
        },
        { endpointId: id },
      );
      const deliveryId = queued?.deliveryIds[0];
      if (!queued || !deliveryId) throw new Error('test event not stored');
      // Leased to this request, as the dispatcher leases what it sends: stored as due now, it was
      // sent a second time by the dispatcher while this attempt waited for a slow answer.
      const lease = leaseSeconds(this.config.WEBHOOK_TIMEOUT_MS) * 1000;
      await tx
        .update(schema.webhookDeliveries)
        .set({ nextAttemptAt: new Date(this.clock().getTime() + lease) })
        .where(eq(schema.webhookDeliveries.id, deliveryId));
      const [delivery] = await tx
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, deliveryId));
      const [event] = await tx
        .select({ body: schema.webhookEvents.body })
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, queued.eventId));
      await this.audit(tx, principal, 'webhook.test_sent', id);
      return {
        delivery: delivery as typeof schema.webhookDeliveries.$inferSelect,
        body: event?.body ?? '',
        prepared: await this.sender.prepare(tx, principal.tenantId, endpoint),
      };
    });
    const result = prepared.prepared
      ? await this.sender.attempt(prepared.prepared, prepared.delivery.eventId, prepared.body)
      : this.sender.unsigned();
    return this.staffTx(principal, async (tx) => {
      await this.sender.record(tx, principal.tenantId, prepared.delivery, result, {
        health: false,
        retry: false,
      });
      const verified = result.judgement.outcome === 'succeeded';
      if (verified) {
        await tx
          .update(schema.webhookEndpoints)
          .set({ verifiedAt: this.clock() })
          .where(eq(schema.webhookEndpoints.id, id));
      }
      const [row] = await tx
        .select({
          delivery: schema.webhookDeliveries,
          url: schema.webhookEndpoints.url,
          type: schema.webhookEvents.type,
        })
        .from(schema.webhookDeliveries)
        .innerJoin(
          schema.webhookEndpoints,
          eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId),
        )
        .innerJoin(
          schema.webhookEvents,
          eq(schema.webhookEvents.id, schema.webhookDeliveries.eventId),
        )
        .where(eq(schema.webhookDeliveries.id, prepared.delivery.id));
      const [attempt] = await tx
        .select()
        .from(schema.webhookAttempts)
        .where(eq(schema.webhookAttempts.deliveryId, prepared.delivery.id))
        .orderBy(desc(schema.webhookAttempts.attempt))
        .limit(1);
      if (!row || !attempt) throw new Error('test attempt not recorded');
      return {
        delivery: deliveryView(row.delivery, row.url, row.type),
        attempt: attemptView(attempt),
        verified,
      };
    });
  }
}
