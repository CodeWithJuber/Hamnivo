import { aiPowerRoutes, CreateWebSourceRequest, UpdateWebSourceRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../../common/idempotency.service.js';
import { parseInput } from '../../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../../identity/request-auth.js';
import { WebSourcesService } from './sources.service.js';

/** Websites kept as knowledge (G04): add, change, read now, and see how each page fared. */
@Controller('v1/admin/knowledge/web-sources')
export class WebSourcesController {
  constructor(
    private readonly webSources: WebSourcesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.webSources.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateWebSourceRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: aiPowerRoutes.createWebSource.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.webSources.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch(':webSourceId')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('webSourceId') webSourceId: string,
    @Body() body: unknown,
  ) {
    return this.webSources.update(principal, webSourceId, parseInput(UpdateWebSourceRequest, body));
  }

  @Post(':webSourceId/sync')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  sync(@CurrentPrincipal() principal: StaffPrincipal, @Param('webSourceId') webSourceId: string) {
    return this.webSources.sync(principal, webSourceId);
  }

  @Get(':webSourceId/pages')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async pages(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('webSourceId') webSourceId: string,
  ) {
    return { items: await this.webSources.pages(principal, webSourceId) };
  }
}
