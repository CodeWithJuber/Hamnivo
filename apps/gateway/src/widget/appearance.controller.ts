import {
  PublishWidgetAppearanceRequest,
  SaveWidgetAppearanceDraftRequest,
  UpdateWidgetAppearanceRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
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
  @Put(':brandId/appearance/draft')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  draft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(SaveWidgetAppearanceDraftRequest, body);
    return this.appearance.saveDraft(principal, brandId, input.appearance, input.expectedRevision);
  }

  @Post(':brandId/appearance/publish')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  publish(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.appearance.publish(
      principal,
      brandId,
      parseInput(PublishWidgetAppearanceRequest, body).expectedRevision,
    );
  }
}
