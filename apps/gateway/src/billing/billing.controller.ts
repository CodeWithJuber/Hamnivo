import { SetBudgetRequest, StartCheckoutRequest } from '@hamnivo/contracts';
import type { RawBodyRequest } from '@nestjs/common';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor, staffOf } from '../developer/actor.js';
import { BillingService } from './billing.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

const READ = { permission: 'billing.read', tenantWide: true, apiKey: true } as const;
const MANAGE = { permission: 'billing.manage', tenantWide: true } as const;

/** Plan, usage, budget, invoices and the subscription through the billing provider (board 23). */
@Controller('v1/admin')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Get('usage')
  @ApiRoute({ permission: ['billing.read', 'analytics.read'], tenantWide: true, apiKey: true })
  usage(@CurrentActor() actor: Actor) {
    return this.billing.usage(actor.tenantId);
  }

  @Get('billing')
  @ApiRoute(READ)
  overview(@CurrentActor() actor: Actor) {
    return this.billing.overview(actor.tenantId);
  }

  @Put('billing/budget')
  @ApiRoute(MANAGE)
  setBudget(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.billing.setBudget(staffOf(actor), parseInput(SetBudgetRequest, body));
  }

  @Get('billing/invoices')
  @ApiRoute(READ)
  async invoices(@CurrentActor() actor: Actor) {
    return { items: await this.billing.invoices(actor.tenantId) };
  }

  @Get('billing/invoices/:id')
  @ApiRoute(READ)
  invoice(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.billing.invoice(actor.tenantId, id);
  }

  @Get('billing/subscription')
  @ApiRoute({ permission: 'billing.read', tenantWide: true })
  subscription(@CurrentActor() actor: Actor) {
    return this.subscriptions.subscription(actor.tenantId);
  }

  @Post('billing/checkout')
  @HttpCode(200)
  @ApiRoute(MANAGE)
  checkout(@CurrentActor() actor: Actor, @Body() body: unknown, @Req() request: FastifyRequest) {
    const { planKey } = parseInput(StartCheckoutRequest, body);
    return this.subscriptions.startCheckout(
      staffOf(actor),
      planKey,
      validIdempotencyKey(request.headers['idempotency-key']),
    );
  }

  @Post('billing/portal')
  @HttpCode(200)
  @ApiRoute(MANAGE)
  portal(@CurrentActor() actor: Actor) {
    return this.subscriptions.openPortal(staffOf(actor));
  }

  @Get('billing/provider-invoices')
  @ApiRoute({ permission: 'billing.read', tenantWide: true })
  async providerInvoices(@CurrentActor() actor: Actor) {
    return { items: await this.subscriptions.providerInvoices(actor.tenantId) };
  }
}

/** Stripe Billing events (signed; checked over the exact raw body). */
@Controller('v1/integrations/billing')
export class BillingWebhooksController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Post('stripe')
  @HttpCode(200)
  async stripe(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    await this.subscriptions.receiveStripe(request.rawBody, request.headers);
    return { received: true };
  }
}
