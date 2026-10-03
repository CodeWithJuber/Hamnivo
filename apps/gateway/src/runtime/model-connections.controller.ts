import {
  agentRoutes,
  CreateModelConnectionRequest,
  ReplaceModelKeyRequest,
  TestModelConnectionRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { ModelConnectionsService } from './model-connections.service.js';

@Controller('v1/admin/model-connections')
export class ModelConnectionsController {
  constructor(
    private readonly connections: ModelConnectionsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.connections.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateModelConnectionRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: agentRoutes.createModelConnection.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        // The idempotency record must not keep the API key.
        body: { ...input, apiKey: `len:${input.apiKey.length}` },
      },
      async () => ({ status: 201, body: await this.connections.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  /** Which keys the server holds, whether Jev is set up, and the last test of each connection. */
  @Get('status')
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  status(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.connections.status(principal);
  }

  /** One real call of a few tokens; the answer says in plain words whether the key works. */
  @Post(':connectionId/test')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  test(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    return this.connections.test(
      principal,
      connectionId,
      parseInput(TestModelConnectionRequest, body),
    );
  }

  /** Replaces the key in place; agents that use the connection carry on with the new one. */
  @Post(':connectionId/rotate')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  rotate(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ) {
    return this.connections.rotate(
      principal,
      connectionId,
      parseInput(ReplaceModelKeyRequest, body),
    );
  }

  @Post(':connectionId/disable')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'integrations.manage', tenantWide: true })
  disable(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('connectionId') connectionId: string,
  ) {
    return this.connections.disable(principal, connectionId);
  }
}
