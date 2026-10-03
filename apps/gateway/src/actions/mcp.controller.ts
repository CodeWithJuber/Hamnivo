import { MCP_PRESETS } from '@hamnivo/adapters/mcp';
import {
  CompleteMcpOAuthRequest,
  StartMcpOAuthRequest,
  UpdateMcpResourceRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { McpCatalogService } from './mcp-catalog.service.js';
import { McpOAuthService } from './mcp-oauth.service.js';
import { ToolsService } from './tools.service.js';

/**
 * What goes with an MCP server beyond its tools (D10): removing it, signing in to it with OAuth,
 * the resources and prompts it lists, and the catalog of services whose vendors run one.
 */
@Controller('v1/admin')
export class McpController {
  constructor(
    private readonly tools: ToolsService,
    private readonly oauth: McpOAuthService,
    private readonly catalog: McpCatalogService,
  ) {}

  @Get('mcp-presets')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  presets() {
    return { items: MCP_PRESETS };
  }

  @Delete('mcp-servers/:serverId')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  async remove(@CurrentPrincipal() principal: StaffPrincipal, @Param('serverId') serverId: string) {
    await this.tools.deleteServer(principal, serverId);
  }

  @Post('mcp-servers/:serverId/oauth/start')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  start(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('serverId') serverId: string,
    @Body() body: unknown,
  ) {
    return this.oauth.start(principal, serverId, parseInput(StartMcpOAuthRequest, body ?? {}));
  }

  /**
   * The person comes back from the service's sign-in page after a few minutes away, so this asks
   * for the permission only; the service checks it again, without a second fresh sign-in (the
   * person who started it passed one).
   */
  @Post('mcp-oauth/complete')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  complete(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.oauth.complete(principal, parseInput(CompleteMcpOAuthRequest, body));
  }

  @Post('mcp-servers/:serverId/oauth/disconnect')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  disconnect(@CurrentPrincipal() principal: StaffPrincipal, @Param('serverId') serverId: string) {
    return this.oauth.disconnect(principal, serverId);
  }

  @Get('mcp-servers/:serverId/catalog')
  @StaffRoute({ tenant: true, permission: 'tools.read' })
  listing(@CurrentPrincipal() principal: StaffPrincipal, @Param('serverId') serverId: string) {
    return this.catalog.get(principal, serverId);
  }

  @Patch('mcp-servers/:serverId/resources/:itemId')
  @StaffRoute({ tenant: true, permission: 'tools.manage' })
  setReadable(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('serverId') serverId: string,
    @Param('itemId') itemId: string,
    @Body() body: unknown,
  ) {
    return this.catalog.setReadable(
      principal,
      serverId,
      itemId,
      parseInput(UpdateMcpResourceRequest, body),
    );
  }
}
