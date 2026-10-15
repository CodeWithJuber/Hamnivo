import { SetSlaPolicyRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { SlaService } from './sla.service.js';

/** A brand's reply-time targets (H12). The service checks inbox.manage on the brand. */
@Controller('v1/admin/brands')
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get(':brandId/sla-policy')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.sla.get(principal, brandId);
  }

  @Put(':brandId/sla-policy')
  @StaffRoute({ tenant: true, permission: 'inbox.manage' })
  set(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.sla.set(principal, brandId, parseInput(SetSlaPolicyRequest, body));
  }
}
