import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get } from '@nestjs/common';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ChatwootProvisioning } from './provisioning.service.js';

/** Progress of the automatic Chatwoot set-up, shown on Brands and install. */
@Controller('v1/admin/authority/provisioning')
export class ProvisioningController {
  constructor(private readonly provisioning: ChatwootProvisioning) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'brands.manage' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.provisioning.list(principal.tenantId) };
  }
}
