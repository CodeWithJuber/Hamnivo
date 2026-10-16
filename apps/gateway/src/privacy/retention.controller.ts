import { RetentionPreviewQuery, SetRetentionRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { RetentionService } from './retention.service.js';

/** How long the workspace keeps resolved conversations (A10). */
@Controller('v1/admin/privacy/retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'privacy.manage', tenantWide: true })
  get(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.retention.get(principal);
  }

  @Put()
  @StaffRoute({ tenant: true, permission: 'privacy.manage', tenantWide: true })
  set(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.retention.set(principal, parseInput(SetRetentionRequest, body));
  }

  @Get('preview')
  @StaffRoute({ tenant: true, permission: 'privacy.manage', tenantWide: true })
  preview(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.retention.preview(principal, parseInput(RetentionPreviewQuery, query).days);
  }
}
