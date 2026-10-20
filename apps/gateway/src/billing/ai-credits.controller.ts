import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get } from '@nestjs/common';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AiCreditsService } from './ai-credits.service.js';

@Controller('v1/admin/ai/usage')
export class AiCreditsController {
  constructor(private readonly credits: AiCreditsService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'billing.read', tenantWide: true })
  overview(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.credits.overview(principal.tenantId);
  }
}
