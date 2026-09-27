import {
  adminRoutes,
  CreateBrandRequest,
  SetBusinessHoursRequest,
  UpdateBrandRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { BrandsService } from './brands.service.js';

@Controller('v1/admin/brands')
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'brands.manage' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.brands.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'brands.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateBrandRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: adminRoutes.createBrand.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.brands.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch(':brandId')
  @StaffRoute({ tenant: true, permission: 'brands.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.brands.update(principal, brandId, parseInput(UpdateBrandRequest, body));
  }

  @Put(':brandId/business-hours')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  setBusinessHours(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(SetBusinessHoursRequest, body);
    return this.brands.setBusinessHours(principal, brandId, input.businessHours);
  }
}
