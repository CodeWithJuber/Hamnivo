import { UpdateOnboardingRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { OnboardingService } from './onboarding.service.js';

/** Where the owner is in the setup wizard (A01). */
@Controller('v1/admin/onboarding')
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'brands.manage', tenantWide: true })
  get(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.onboarding.get(principal);
  }

  @Put()
  @StaffRoute({ tenant: true, permission: 'brands.manage', tenantWide: true })
  update(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.onboarding.update(principal, parseInput(UpdateOnboardingRequest, body));
  }
}
