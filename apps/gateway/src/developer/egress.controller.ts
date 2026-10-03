import { SetEgressHostsRequest } from '@hamnivo/contracts';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor, staffOf } from './actor.js';
import { EgressService } from './egress.service.js';

/** The network egress allowlist (X05). */
@Controller('v1/admin/network/egress')
export class EgressController {
  constructor(private readonly egress: EgressService) {}

  @Get()
  @ApiRoute({ permission: ['webhooks.read', 'network.manage'], tenantWide: true })
  get(@CurrentActor() actor: Actor) {
    return this.egress.get(actor.tenantId);
  }

  @Put()
  @ApiRoute({ permission: 'network.manage', tenantWide: true })
  set(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.egress.setHosts(staffOf(actor), parseInput(SetEgressHostsRequest, body));
  }
}
