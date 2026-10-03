import {
  type BillingProvider,
  FreeBillingProvider,
  StripeBillingProvider,
  WhmcsBillingProvider,
} from '@hamnivo/adapters/billing';
import type { Provider } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';

/** The server's billing provider (BILLING_PROVIDER): free, Stripe Billing or WHMCS. */
export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

export function billingProviderFrom(config: AppConfig): BillingProvider {
  switch (config.BILLING_PROVIDER) {
    case 'stripe':
      // loadConfig refuses BILLING_PROVIDER=stripe without the key and the webhook secret.
      return new StripeBillingProvider({
        apiKey: config.STRIPE_SECRET_KEY as string,
        apiBase: config.STRIPE_API_BASE ?? null,
      });
    case 'whmcs':
      return new WhmcsBillingProvider({ clientAreaUrl: config.WHMCS_CLIENT_AREA_URL ?? null });
    default:
      return new FreeBillingProvider();
  }
}

export const billingProvider: Provider = {
  provide: BILLING_PROVIDER,
  inject: [CONFIG],
  useFactory: (config: AppConfig) => billingProviderFrom(config),
};
