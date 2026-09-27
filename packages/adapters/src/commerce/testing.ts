/** Test tooling: the stateful fake Stripe server (never used in production code). */
export {
  defaultFakeProducts,
  type FakeStripe,
  type FakeStripeFault,
  type FakeStripeProduct,
  parseStripeForm,
  startFakeStripe,
} from './stripe-fake.js';
