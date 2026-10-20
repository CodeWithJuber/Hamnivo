import { RegisterBrandingDomainRequest, UpdateBrandingRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { BrandingService } from './branding.service.js';
@Controller('v1/admin/branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}
  @Get()
  @StaffRoute({ tenant: true, permission: 'branding.read', tenantWide: true })
  settings(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.branding.settings(principal);
  }
  @Put()
  @StaffRoute({ tenant: true, permission: 'branding.manage', tenantWide: true })
  update(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.branding.update(principal, parseInput(UpdateBrandingRequest, body));
  }
  @Post('domains')
  @StaffRoute({ tenant: true, permission: 'branding.manage', tenantWide: true })
  register(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.branding.register(
      principal,
      parseInput(RegisterBrandingDomainRequest, body).hostname,
    );
  }
  @Post('domains/:id/verify')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'branding.manage', tenantWide: true })
  verify(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    return this.branding.verify(principal, id);
  }
  @Post('domains/:id/disable')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'branding.manage', tenantWide: true })
  disable(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    return this.branding.disable(principal, id);
  }
}
@Controller('v1/branding')
export class PublicBrandingController {
  constructor(private readonly branding: BrandingService) {}
  @Get()
  async resolve(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return this.branding.publicBranding(request.headers.host);
  }
}
