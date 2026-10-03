import {
  AddHttpEndpointsRequest,
  aiPowerRoutes,
  CreateHttpSourceRequest,
  PreviewHttpSpecRequest,
  UpdateHttpEndpointRequest,
  UpdateHttpSourceRequest,
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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../../common/idempotency.service.js';
import { parseInput } from '../../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../../identity/request-auth.js';
import { HttpToolsService } from './service.js';

/**
 * Custom HTTP tools in Studio (D10): services with an address and a credential, and the tools that
 * are requests to them, imported from an OpenAPI description or written by hand.
 */
@Controller('v1/admin/http-tools')
export class HttpToolsController {
  constructor(
    private readonly http: HttpToolsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('sources')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(aiPowerRoutes.listHttpToolSources.query, query ?? {});
    return { items: await this.http.list(principal, input.brandId) };
  }

  @Post('preview')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  preview(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.http.preview(principal, parseInput(PreviewHttpSpecRequest, body));
  }

  @Post('sources')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateHttpSourceRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: aiPowerRoutes.createHttpToolSource.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.http.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch('sources/:sourceId')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ) {
    return this.http.update(principal, sourceId, parseInput(UpdateHttpSourceRequest, body));
  }

  @Delete('sources/:sourceId')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async remove(@CurrentPrincipal() principal: StaffPrincipal, @Param('sourceId') sourceId: string) {
    await this.http.remove(principal, sourceId);
  }

  @Post('sources/:sourceId/endpoints')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async addEndpoints(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(AddHttpEndpointsRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: `${aiPowerRoutes.addHttpToolEndpoints.operationId}:${sourceId}`,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({
        status: 201,
        body: await this.http.addEndpoints(principal, sourceId, input),
      }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Put('sources/:sourceId/endpoints/:toolId')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  updateEndpoint(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
    @Param('toolId') toolId: string,
    @Body() body: unknown,
  ) {
    return this.http.updateEndpoint(
      principal,
      sourceId,
      toolId,
      parseInput(UpdateHttpEndpointRequest, body),
    );
  }
}
