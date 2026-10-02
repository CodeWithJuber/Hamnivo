import { UpdateProactiveSettingsRequest, UpdateWidgetSettingsRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { WidgetSettingsService } from './settings.service.js';

/** Brand settings for the customer surface (W02, W09, W17, W19, W23, W25). */
@Controller('v1/admin/brands')
export class WidgetSettingsController {
  constructor(private readonly settings: WidgetSettingsService) {}

  @Get(':brandId/widget-settings')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.settings.getSettings(principal, brandId);
  }

  @Put(':brandId/widget-settings')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.settings.updateSettings(
      principal,
      brandId,
      parseInput(UpdateWidgetSettingsRequest, body),
    );
  }

  @Get(':brandId/proactive')
  @StaffRoute({ tenant: true, permission: 'widget.proactive' })
  getProactive(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.settings.getProactive(principal, brandId);
  }

  @Put(':brandId/proactive')
  @StaffRoute({ tenant: true, permission: 'widget.proactive' })
  updateProactive(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.settings.updateProactive(
      principal,
      brandId,
      parseInput(UpdateProactiveSettingsRequest, body),
    );
  }
}
