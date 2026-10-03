import { Controller, Delete, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Actor, ApiRoute, CurrentActor } from '../developer/actor.js';
import { McpServerService } from './mcp-server.service.js';

const NOT_ALLOWED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed: send requests with POST.' },
  id: null,
} as const;

/**
 * Hamnivo's MCP server (Streamable HTTP). Requests are POSTs with an API key that holds
 * `mcp.read`; there are no sessions and no server-sent streams, so a GET or a DELETE is refused as
 * the specification describes.
 */
@Controller('mcp')
export class McpServerController {
  constructor(private readonly mcp: McpServerService) {}

  @Post()
  @HttpCode(200)
  @ApiRoute({ permission: 'mcp.read', apiKey: true, staff: false })
  async post(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    await this.mcp.handle(actor, request, reply);
  }

  @Get()
  get(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(405).header('allow', 'POST');
    return NOT_ALLOWED;
  }

  @Delete()
  remove(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.status(405).header('allow', 'POST');
    return NOT_ALLOWED;
  }
}
