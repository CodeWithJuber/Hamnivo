import { CommerceCacheRules } from './answer-cache.js';
import { CommerceCardsService } from './card-publisher.service.js';
import { CartsService } from './carts.service.js';
import { CheckoutService } from './checkout.service.js';
import { FinanceExceptionsService } from './exceptions.service.js';
import { MerchantsService } from './merchants.service.js';
import { OrdersService } from './orders.service.js';
import { CommerceProviders } from './providers.service.js';
import { PurchasesService } from './purchases.service.js';
import { RefundsService } from './refunds.service.js';
import { StaffCommerceController } from './staff-commerce.controller.js';
import { CommerceWebhooksController } from './webhooks.controller.js';
import { CommerceWebhooksService } from './webhooks.service.js';
import { WidgetCommerceController } from './widget-commerce.controller.js';
import { CommerceWorker } from './worker.service.js';

/**
 * Commerce wiring (blueprint §23). The API serves the widget, Studio and provider webhooks; the
 * worker applies provider events and reconciles what is still owed an outcome. Both rely on the
 * platform, secret broker and authority services their modules already provide.
 */
const shared = [
  // K06: answers built from commerce data never enter or leave the answer cache.
  CommerceCacheRules,
  CommerceProviders,
  CommerceCardsService,
  PurchasesService,
  CheckoutService,
  RefundsService,
];

export const COMMERCE_API_CONTROLLERS = [
  WidgetCommerceController,
  StaffCommerceController,
  CommerceWebhooksController,
];

export const COMMERCE_API_PROVIDERS = [
  ...shared,
  CartsService,
  OrdersService,
  FinanceExceptionsService,
  MerchantsService,
  CommerceWebhooksService,
];

export const COMMERCE_WORKER_PROVIDERS = [...shared, CommerceWorker];
