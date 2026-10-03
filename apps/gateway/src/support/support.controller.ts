import { ApproveSupportRequest, DecideSupportRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { SupportService } from './support.service.js';

/**
 * Support access, the tenant's side (A18). support.grant is an owner-level permission that needs
 * two-step verification and a fresh sign-in; the notices are for every active member.
 */
@Controller('v1')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('admin/support-grants')
  @StaffRoute({ tenant: true, permission: 'support.grant', tenantWide: true })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.support.list(principal) };
  }

  @Post('admin/support-grants/:id/approve')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'support.grant', tenantWide: true })
  approve(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.support.approve(principal, id, parseInput(ApproveSupportRequest, body ?? {}));
  }

  @Post('admin/support-grants/:id/decline')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'support.grant', tenantWide: true })
  decline(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.support.decline(principal, id, parseInput(DecideSupportRequest, body ?? {}).note);
  }

  @Post('admin/support-grants/:id/revoke')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'support.grant', tenantWide: true })
  revoke(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.support.revoke(principal, id, parseInput(DecideSupportRequest, body ?? {}).note);
  }

  @Get('workspace/notices')
  @StaffRoute({ tenant: true })
  notices(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.support.notices(principal);
  }
}
