import {
  CreateAgencyClientRequest,
  LinkAgencyClientRequest,
  UpdateAgencySettingsRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { CurrentPrincipal, CurrentSession, StaffRoute } from '../identity/request-auth.js';
import { AgencyService } from './agency.service.js';

@Controller('v1/admin/agency')
export class AgencyController {
  constructor(private readonly agency: AgencyService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'agency.read', tenantWide: true })
  settings(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.agency.settings(principal);
  }

  @Patch()
  @StaffRoute({ tenant: true, permission: 'agency.manage', tenantWide: true })
  update(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.agency.update(principal, parseInput(UpdateAgencySettingsRequest, body));
  }

  @Get('clients')
  @StaffRoute({ tenant: true, permission: 'agency.read', tenantWide: true })
  list(@CurrentPrincipal() principal: StaffPrincipal, @CurrentSession() session: AuthSession) {
    return this.agency.list(principal, session);
  }

  @Get('clients/:tenantId')
  @StaffRoute({ tenant: true, permission: 'agency.read', tenantWide: true })
  detail(
    @CurrentPrincipal() principal: StaffPrincipal,
    @CurrentSession() session: AuthSession,
    @Param('tenantId') tenantId: string,
  ) {
    return this.agency.detail(principal, session, tenantId);
  }

  @Post('clients')
  @StaffRoute({ tenant: true, permission: 'agency.manage', tenantWide: true })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateAgencyClientRequest, body);
    const key = validIdempotencyKey(request.headers['idempotency-key']);
    const result = await this.agency.create(principal, session, input, key);
    reply.status(201);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.client;
  }

  @Post('clients/link')
  @StaffRoute({ tenant: true, permission: 'agency.manage', tenantWide: true })
  @HttpCode(201)
  link(
    @CurrentPrincipal() principal: StaffPrincipal,
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ) {
    const { tenantId } = parseInput(LinkAgencyClientRequest, body);
    return this.agency.link(principal, session, tenantId);
  }

  @Delete('clients/:tenantId')
  @StaffRoute({ tenant: true, permission: 'agency.manage', tenantWide: true })
  @HttpCode(204)
  async unlink(@CurrentPrincipal() principal: StaffPrincipal, @Param('tenantId') tenantId: string) {
    await this.agency.unlink(principal, tenantId);
  }
}
