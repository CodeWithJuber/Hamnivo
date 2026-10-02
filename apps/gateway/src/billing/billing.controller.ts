import { SetBudgetRequest } from '@hamnivo/contracts';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor, staffOf } from '../developer/actor.js';
import { BillingService } from './billing.service.js';

const READ = { permission: 'billing.read', tenantWide: true, apiKey: true } as const;

/** Plan, usage, budget and invoices (board 23). */
@Controller('v1/admin')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

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
  @ApiRoute({ permission: 'billing.manage', tenantWide: true })
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
}
