import {
  CreateMcpServerRequest,
  CreateToolRequest,
  DecideActionRequest,
  ResolveActionRequest,
  toolAdminRoutes,
  UpdateActionSettingsRequest,
  UpdateMcpServerRequest,
  UpdateToolRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NoStoreInterceptor } from '../commerce/no-store.interceptor.js';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { CurrentWidget, WidgetRoute } from '../widget/widget.guard.js';
import { ActionApprovals } from './approvals.service.js';
import { HandoffPackets } from './handoff.service.js';
import { InboxActions } from './inbox-actions.service.js';
import { ToolsService } from './tools.service.js';

const LOCALES = new Set(['en', 'ar', 'hi', 'ur']);

/** Tools, MCP servers, action settings, the action log and run cancellation in Studio. */
@Controller('v1/admin')
export class ToolsController {
  constructor(
    private readonly tools: ToolsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('tools')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(toolAdminRoutes.listTools.query, query ?? {});
    return { items: await this.tools.list(principal, input.brandId) };
  }

  @Get('tools/builtins')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  builtins() {
    return { items: this.tools.builtins() };
  }

  @Post('tools')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateToolRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: toolAdminRoutes.createTool.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({ status: 201, body: await this.tools.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get('tools/:toolId')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('toolId') toolId: string) {
    return this.tools.get(principal, toolId);
  }

  @Patch('tools/:toolId')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('toolId') toolId: string,
    @Body() body: unknown,
  ) {
    return this.tools.update(principal, toolId, parseInput(UpdateToolRequest, body));
  }

  @Get('mcp-servers')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  async servers(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(toolAdminRoutes.listMcpServers.query, query ?? {});
    return { items: await this.tools.listServers(principal, input.brandId) };
  }

  @Post('mcp-servers')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async createServer(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateMcpServerRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: toolAdminRoutes.createMcpServer.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        // The token never enters the idempotency record.
        body: { ...input, token: input.token ? 'provided' : null },
      },
      async () => ({ status: 201, body: await this.tools.createServer(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch('mcp-servers/:serverId')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  updateServer(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
  ) {
    return this.tools.updateServer(principal, serverId, parseInput(UpdateMcpServerRequest, body));
  }

  @Post('mcp-servers/:serverId/sync')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  sync(@CurrentPrincipal() principal: StaffPrincipal, @Param('serverId') serverId: string) {
    return this.tools.syncServer(principal, serverId);
  }

  @Get('action-settings')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  settings(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.tools.settings(principal);
  }

  @Put('action-settings')
  @StaffRoute({ tenant: true, permission: 'tools.manage', tenantWide: true })
  updateSettings(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.tools.updateSettings(principal, parseInput(UpdateActionSettingsRequest, body));
  }

  @Get('actions')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  actions(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.tools.listActions(principal, parseInput(toolAdminRoutes.listActions.query, query));
  }

  @Post('runs/:runId/cancel')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'conversations.takeover' })
  cancelRun(@CurrentPrincipal() principal: StaffPrincipal, @Param('runId') runId: string) {
    return this.tools.cancelRun(principal, runId);
  }
}

/** The actions, approvals and handoff packets of one conversation in the staff inbox. */
@Controller('v1/inbox/conversations/:conversationId')
export class InboxActionsController {
  constructor(
    private readonly approvals: ActionApprovals,
    private readonly inbox: InboxActions,
    private readonly handoffs: HandoffPackets,
  ) {}

  @Get('actions')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  async list(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
  ) {
    return { items: await this.approvals.listForStaff(principal, conversationId) };
  }

  @Post('actions/:actionId/decision')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.approve' })
  decide(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.approvals.decideAsStaff(
      principal,
      conversationId,
      actionId,
      parseInput(DecideActionRequest, body),
    );
  }

  @Post('actions/:actionId/check')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.approve' })
  check(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
  ) {
    return this.inbox.check(principal, conversationId, actionId);
  }

  @Post('actions/:actionId/resolve')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.approve' })
  resolve(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
  ) {
    return this.inbox.resolve(
      principal,
      conversationId,
      actionId,
      parseInput(ResolveActionRequest, body),
    );
  }

  @Get('handoff-packets')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  async handoffPackets(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
  ) {
    return { items: await this.handoffs.list(principal, conversationId) };
  }
}

/** Approval cards in the widget (W16): the customer's own requests only. */
@Controller('v1/widget/conversations/:conversationId/actions')
@UseInterceptors(NoStoreInterceptor)
export class WidgetActionsController {
  constructor(private readonly approvals: ActionApprovals) {}

  @Get(':actionId')
  @WidgetRoute()
  get(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
  ) {
    return this.approvals.getForCustomer(claims, conversationId, actionId);
  }

  @Post(':actionId/decision')
  @WidgetRoute()
  @HttpCode(200)
  decide(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('actionId') actionId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const language = request.headers['accept-language']?.split(',')[0]?.split('-')[0] ?? null;
    const origin = request.headers.origin;
    return this.approvals.decideAsCustomer(
      claims,
      conversationId,
      actionId,
      parseInput(DecideActionRequest, body),
      {
        locale: language && LOCALES.has(language) ? language : null,
        origin: typeof origin === 'string' ? origin.slice(0, 200) : null,
      },
    );
  }
}
