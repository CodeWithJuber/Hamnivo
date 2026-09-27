import {
  AddSsoDomainRequest,
  CreateSsoConnectionRequest,
  UpdateSsoConnectionRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseInput } from '../../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../request-auth.js';
import { SsoService } from './sso.service.js';

/**
 * Enterprise sign-in settings (A13). security.manage is a tenant-level permission that needs
 * two-step verification and a fresh sign-in, so every route here asks for both.
 */
@Controller('v1/admin/sso')
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  settings(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.sso.settings(principal);
  }

  @Post('domains')
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  addDomain(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.sso.addDomain(principal, parseInput(AddSsoDomainRequest, body));
  }

  @Post('domains/:id/verify')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  verifyDomain(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    return this.sso.verifyDomain(principal, id);
  }

  @Delete('domains/:id')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  async removeDomain(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    await this.sso.removeDomain(principal, id);
  }

  @Post('connections')
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  createConnection(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.sso.createConnection(principal, parseInput(CreateSsoConnectionRequest, body));
  }

  @Patch('connections/:id')
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  updateConnection(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.sso.updateConnection(principal, id, parseInput(UpdateSsoConnectionRequest, body));
  }

  @Delete('connections/:id')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'security.manage', tenantWide: true })
  async deleteConnection(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    await this.sso.deleteConnection(principal, id);
  }
}
