import { CreateIdentityKeyRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { IdentityKeysService } from './identity-keys.service.js';

/** Keys that verify a brand's customer identity assertions (W12). */
@Controller('v1/admin/brands/:brandId/identity-keys')
export class IdentityKeysController {
  constructor(private readonly keys: IdentityKeysService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return { items: await this.keys.list(principal, brandId) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'widget.identity_keys' })
  @HttpCode(201)
  create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.keys.create(principal, brandId, parseInput(CreateIdentityKeyRequest, body));
  }

  @Post(':kid/retire')
  @StaffRoute({ tenant: true, permission: 'widget.identity_keys' })
  @HttpCode(200)
  retire(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('kid') kid: string,
  ) {
    return this.keys.retire(principal, brandId, kid);
  }

  @Post(':kid/revoke')
  @StaffRoute({ tenant: true, permission: 'widget.identity_keys' })
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Param('kid') kid: string,
  ) {
    return this.keys.revoke(principal, brandId, kid);
  }
}
