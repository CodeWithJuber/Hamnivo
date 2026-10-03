import { PlaygroundRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { PlaygroundService } from './playground.service.js';

/** "Test your AI": a scratch conversation with an agent. Nothing is stored or sent anywhere. */
@Controller('v1/admin/agents')
export class PlaygroundController {
  constructor(private readonly playground: PlaygroundService) {}

  @Post(':agentId/playground')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  @Header('cache-control', 'no-store')
  run(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    return this.playground.run(principal, agentId, parseInput(PlaygroundRequest, body));
  }
}
