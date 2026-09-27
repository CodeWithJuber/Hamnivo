import type {
  CreateMerchantConnectionRequest,
  MerchantConnection,
  UpdateMerchantConnectionRequest,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import type { MerchantConfig } from '@hamnivo/db/schema';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { enforce } from '../identity/staff.guard.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { brandScope, decide, requireBrand } from './access.js';
import { CommerceProviders, type MerchantRow } from './providers.service.js';
import { merchantView } from './views.js';

type CreateInput = z.output<typeof CreateMerchantConnectionRequest>;
type UpdateInput = z.output<typeof UpdateMerchantConnectionRequest>;

/**
 * Merchant connections (C01) with their capability manifests (E02). Credentials go straight to
 * the secret broker; the API shows only whether they are set and their last characters.
 */
@Injectable()
export class MerchantsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly secrets: SecretBroker,
    private readonly providers: CommerceProviders,
  ) {}

  private options() {
    return { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000 };
  }

  private staffTx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }

  private async views(tx: TenantTx, rows: MerchantRow[]): Promise<MerchantConnection[]> {
    const ids = rows
      .flatMap((r) => [r.apiKeySecretId, r.webhookSecretId])
      .filter((id): id is string => !!id);
    const hints = new Map(
      ids.length
        ? (
            await tx
              .select({ id: schema.secrets.id, hint: schema.secrets.hint })
              .from(schema.secrets)
              .where(inArray(schema.secrets.id, ids))
          ).map((s) => [s.id, s.hint ?? ''])
        : [],
    );
    const hint = (id: string | null) => (id ? (hints.get(id) ?? '') : null);
    return rows.map((row) =>
      merchantView(
        row,
        { apiKey: hint(row.apiKeySecretId), webhookSecret: hint(row.webhookSecretId) },
        this.config.PUBLIC_API_ORIGIN,
      ),
    );
  }

  async list(principal: StaffPrincipal): Promise<MerchantConnection[]> {
    return this.staffTx(principal, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.merchantConnections)
        .orderBy(asc(schema.merchantConnections.createdAt));
      const visible: MerchantRow[] = [];
      for (const row of rows) {
        const scope = await brandScope(tx, row.brandId);
        if (scope && decide(principal, 'commerce.read', scope, this.options()).allowed)
          visible.push(row);
      }
      return this.views(tx, visible);
    });
  }

  private capabilities(provider: MerchantRow['provider'], config: MerchantConfig) {
    const caps = this.providers.describe(provider, {
      currencies: config.currencies,
      countries: config.countries ?? [],
      ...(config.mockStoreId ? { mockStoreId: config.mockStoreId } : {}),
    });
    const unsupported = config.currencies.filter((c) => !caps.currencies.includes(c));
    if (unsupported.length) {
      throw new AppError('VALIDATION_FAILED', {
        fields: [{ path: 'currencies', message: `Not supported here: ${unsupported.join(', ')}` }],
      });
    }
    return caps;
  }

  async create(principal: StaffPrincipal, input: CreateInput): Promise<MerchantConnection> {
    return this.staffTx(principal, async (tx) => {
      const scope = await brandScope(tx, fromPublicId('brand', input.brandId));
      requireBrand(principal, 'commerce.read', scope, this.options(), 'Brand not found.');
      if (!scope) throw new AppError('NOT_FOUND');
      enforce(decide(principal, 'commerce.merchants.manage', scope, this.options()));
      if (input.provider === 'mock' && !this.providers.mockAllowed()) {
        throw new AppError('FEATURE_DISABLED', { detail: 'Demo shops are turned off here.' });
      }
      if (input.provider === 'stripe' && (!input.apiKey || !input.webhookSecret)) {
        throw new AppError('VALIDATION_FAILED', {
          fields: [
            ...(input.apiKey ? [] : [{ path: 'apiKey', message: 'Required for Stripe' }]),
            ...(input.webhookSecret
              ? []
              : [{ path: 'webhookSecret', message: 'Required for Stripe' }]),
          ],
        });
      }
      const [active] = await tx
        .select({ id: schema.merchantConnections.id })
        .from(schema.merchantConnections)
        .where(
          and(
            eq(schema.merchantConnections.brandId, scope.brandId),
            eq(schema.merchantConnections.status, 'active'),
          ),
        );
      if (active) {
        throw new AppError('VERSION_CONFLICT', {
          detail: 'This brand already has an active shop connection. Disable it first.',
        });
      }
      const config: MerchantConfig = {
        currencies: [...new Set(input.currencies)],
        countries: input.countries,
        shipping: input.shipping,
        taxMode: 'included',
        refundPolicy: input.refundPolicy,
        terms: input.terms,
        quoteMinutes: input.quoteMinutes,
        ...(input.mockStoreId ? { mockStoreId: input.mockStoreId } : {}),
      };
      const capabilities = this.capabilities(input.provider, config);
      const label = `${input.provider}: ${input.displayName}`;
      const apiKeySecretId = input.apiKey
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'commerce_api_key',
            label,
            value: input.apiKey,
          })
        : null;
      const webhookSecretId = input.webhookSecret
        ? await this.secrets.storeIn(tx, principal.tenantId, {
            kind: 'commerce_webhook_secret',
            label,
            value: input.webhookSecret,
          })
        : null;
      const [row] = await tx
        .insert(schema.merchantConnections)
        .values({
          tenantId: principal.tenantId,
          workspaceId: scope.workspaceId,
          brandId: scope.brandId,
          provider: input.provider,
          displayName: input.displayName,
          providerAccountId: input.providerAccountId ?? null,
          capabilities: capabilities as unknown as Record<string, unknown>,
          config,
          apiKeySecretId,
          webhookSecretId,
          createdBy: principal.staffMemberId,
        })
        .returning();
      if (!row) throw new Error('merchant insert returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action: 'commerce.merchant.connected',
        targetType: 'merchant_connection',
        targetId: toPublicId('merchant', row.id),
        outcome: 'success',
        occurredAt: this.clock(),
        data: {
          brand: input.brandId,
          provider: input.provider,
          currencies: config.currencies,
          credentials: { apiKey: apiKeySecretId !== null, webhookSecret: webhookSecretId !== null },
        },
      });
      const [view] = await this.views(tx, [row]);
      return view as MerchantConnection;
    });
  }

  async update(
    principal: StaffPrincipal,
    publicId: string,
    input: UpdateInput,
  ): Promise<MerchantConnection> {
    return this.staffTx(principal, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.merchantConnections)
        .where(eq(schema.merchantConnections.id, fromPublicId('merchant', publicId)))
        .for('update');
      const scope = row ? await brandScope(tx, row.brandId) : null;
      requireBrand(principal, 'commerce.read', scope, this.options(), 'Shop connection not found.');
      if (!row || !scope) throw new AppError('NOT_FOUND');
      enforce(decide(principal, 'commerce.merchants.manage', scope, this.options()));
      const now = this.clock();
      const config: MerchantConfig = {
        ...row.config,
        ...(input.currencies ? { currencies: [...new Set(input.currencies)] } : {}),
        ...(input.shipping !== undefined ? { shipping: input.shipping } : {}),
        ...(input.refundPolicy ? { refundPolicy: input.refundPolicy } : {}),
        ...(input.terms ? { terms: input.terms } : {}),
        ...(input.quoteMinutes ? { quoteMinutes: input.quoteMinutes } : {}),
      };
      const capabilities = input.currencies
        ? (this.capabilities(row.provider, config) as unknown as Record<string, unknown>)
        : row.capabilities;
      if (input.status === 'active' && row.status !== 'active') {
        const [other] = await tx
          .select({ id: schema.merchantConnections.id })
          .from(schema.merchantConnections)
          .where(
            and(
              eq(schema.merchantConnections.brandId, row.brandId),
              eq(schema.merchantConnections.status, 'active'),
              ne(schema.merchantConnections.id, row.id),
            ),
          );
        if (other) {
          throw new AppError('VERSION_CONFLICT', {
            detail: 'This brand already has an active shop connection.',
          });
        }
      }
      const rotate = async (
        current: string | null,
        value: string | undefined,
        kind: 'commerce_api_key' | 'commerce_webhook_secret',
      ) => {
        if (!value) return current;
        if (current) {
          await tx
            .update(schema.secrets)
            .set({ revokedAt: now })
            .where(eq(schema.secrets.id, current));
        }
        return this.secrets.storeIn(tx, principal.tenantId, {
          kind,
          label: `${row.provider}: ${input.displayName ?? row.displayName}`,
          value,
        });
      };
      const [updated] = await tx
        .update(schema.merchantConnections)
        .set({
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.status ? { status: input.status } : {}),
          config,
          capabilities,
          apiKeySecretId: await rotate(row.apiKeySecretId, input.apiKey, 'commerce_api_key'),
          webhookSecretId: await rotate(
            row.webhookSecretId,
            input.webhookSecret,
            'commerce_webhook_secret',
          ),
          updatedAt: now,
        })
        .where(eq(schema.merchantConnections.id, row.id))
        .returning();
      if (!updated) throw new Error('merchant update returned nothing');
      await appendAudit(tx, {
        actorType: 'staff',
        actorId: toPublicId('staff', principal.staffMemberId),
        action:
          input.status === 'disabled' ? 'commerce.merchant.disabled' : 'commerce.merchant.updated',
        targetType: 'merchant_connection',
        targetId: publicId,
        outcome: 'success',
        occurredAt: now,
        // Names of what changed only; credential values never enter the audit log.
        data: { changed: Object.keys(input).sort() },
      });
      const [view] = await this.views(tx, [updated]);
      return view as MerchantConnection;
    });
  }
}
