import {
  type CommerceProvider,
  MockCommerceProvider,
  MockCommerceStore,
  StripeCommerceProvider,
} from '@hamnivo/adapters/commerce';
import { schema, type TenantTx } from '@hamnivo/db';
import type { CommerceCapabilities } from '@hamnivo/domain/commerce';
import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { SecretBroker } from '../secrets/secret-broker.service.js';
import { CONFIG } from '../tokens.js';

export type MerchantRow = typeof schema.merchantConnections.$inferSelect;

/**
 * Builds the provider adapter for a merchant connection. Credentials come from the secret
 * broker inside the caller's tenant transaction, live only as long as the adapter, and are never
 * logged, returned or cached: the adapter is built for one unit of work.
 */
@Injectable()
export class CommerceProviders {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly secrets: SecretBroker,
  ) {}

  /** Whether a `mock` connection may be created here (never in production unless allowed). */
  mockAllowed(): boolean {
    return this.config.NODE_ENV !== 'production' || this.config.COMMERCE_ALLOW_MOCK;
  }

  /** The adapter with no credentials, for capability manifests only (E02). */
  describe(
    provider: MerchantRow['provider'],
    settings: { currencies: string[]; countries?: string[]; mockStoreId?: string },
  ): CommerceCapabilities {
    switch (provider) {
      case 'stripe':
        return new StripeCommerceProvider({
          apiKey: 'sk_capabilities_only',
          currencies: settings.currencies,
          countries: settings.countries ?? [],
        }).capabilities();
      case 'mock': {
        const caps = new MockCommerceProvider(
          MockCommerceStore.get(settings.mockStoreId ?? 'default'),
        ).capabilities();
        return {
          ...caps,
          currencies: caps.currencies.filter((c) => settings.currencies.includes(c)),
        };
      }
      default:
        throw new AppError('CAPABILITY_UNSUPPORTED', {
          detail: 'This provider is not available yet.',
        });
    }
  }

  async forConnection(tx: TenantTx, merchant: MerchantRow): Promise<CommerceProvider> {
    const config = merchant.config;
    switch (merchant.provider) {
      case 'stripe': {
        if (!merchant.apiKeySecretId) {
          throw new AppError('FEATURE_DISABLED', {
            detail: 'The shop has no payment credentials yet.',
          });
        }
        const apiKey = await this.secrets.reveal(tx, merchant.tenantId, merchant.apiKeySecretId);
        return new StripeCommerceProvider({
          apiKey,
          currencies: config.currencies,
          countries: config.countries ?? [],
          shipping: config.shipping
            ? { amountMinor: BigInt(config.shipping.amountMinor), label: config.shipping.label }
            : null,
          taxMode: config.taxMode ?? 'included',
          accountId: merchant.providerAccountId,
          timeoutMs: this.config.COMMERCE_PROVIDER_TIMEOUT_MS,
          apiBase: this.config.COMMERCE_STRIPE_API_BASE ?? null,
        });
      }
      case 'mock': {
        if (!this.mockAllowed()) {
          throw new AppError('FEATURE_DISABLED', { detail: 'Demo shops are turned off here.' });
        }
        const store = MockCommerceStore.get(config.mockStoreId ?? merchant.id);
        if (config.shipping !== undefined) {
          store.shipping = config.shipping
            ? { amountMinor: BigInt(config.shipping.amountMinor), label: config.shipping.label }
            : null;
        }
        return new MockCommerceProvider(store);
      }
      default:
        throw new AppError('CAPABILITY_UNSUPPORTED', {
          detail: 'This provider is not available yet.',
        });
    }
  }

  /** The webhook signing secret of a connection, or null when none is configured. */
  async webhookSecret(tx: TenantTx, merchant: MerchantRow): Promise<string | null> {
    if (!merchant.webhookSecretId) return null;
    return this.secrets.reveal(tx, merchant.tenantId, merchant.webhookSecretId);
  }
}
