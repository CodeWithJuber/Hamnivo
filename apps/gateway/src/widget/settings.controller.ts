import {
  UpdateConsentSettingsRequest,
  UpdateDirectLinkRequest,
  UpdateWidgetFormsRequest,
  UpdateWidgetSettingsRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { WidgetSettingsService } from './settings.service.js';

/** Brand settings for the customer surface (W02, W09, W17, W23, W25, W26, W27, W28). */
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

  @Get(':brandId/widget-forms')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  getForms(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.settings.getForms(principal, brandId);
  }

  @Put(':brandId/widget-forms')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  updateForms(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.settings.updateForms(
      principal,
      brandId,
      parseInput(UpdateWidgetFormsRequest, body),
    );
  }

  @Get(':brandId/consent')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  getConsent(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.settings.getConsent(principal, brandId);
  }

  @Put(':brandId/consent')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  updateConsent(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.settings.updateConsent(
      principal,
      brandId,
      parseInput(UpdateConsentSettingsRequest, body),
    );
  }

  @Get(':brandId/direct-link')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  getDirectLink(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.settings.getDirectLink(principal, brandId);
  }

  @Put(':brandId/direct-link')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  updateDirectLink(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.settings.updateDirectLink(
      principal,
      brandId,
      parseInput(UpdateDirectLinkRequest, body).enabled,
    );
  }
}
