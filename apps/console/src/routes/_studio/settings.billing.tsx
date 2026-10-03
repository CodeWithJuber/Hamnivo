import { createFileRoute } from '@tanstack/react-router';
import { BillingPage } from '../../pages/settings/BillingPage';

export interface BillingSearch {
  /** Back from the billing provider's checkout. */
  checkout?: 'done' | 'cancelled';
}

export const Route = createFileRoute('/_studio/settings/billing')({
  validateSearch: (search: Record<string, unknown>): BillingSearch =>
    search.checkout === 'done' || search.checkout === 'cancelled'
      ? { checkout: search.checkout }
      : {},
  component: BillingPage,
});
