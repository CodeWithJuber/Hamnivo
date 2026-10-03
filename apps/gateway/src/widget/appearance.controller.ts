import { UpdateWidgetAppearanceRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { WidgetAppearanceService } from './appearance.service.js';

/** How a brand's chat looks and what it says (W03). */
@Controller('v1/admin/brands')
export class WidgetAppearanceController {
  constructor(private readonly appearance: WidgetAppearanceService) {}

  @Get(':brandId/appearance')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.appearance.get(principal, brandId);
  }

  @Put(':brandId/appearance')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  set(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.appearance.set(principal, brandId, parseInput(UpdateWidgetAppearanceRequest, body));
  }
}
