import { agentRoutes } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Controller, Get, Param, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { RunsService } from './runs.service.js';

@Controller('v1/admin/runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'analytics.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.runs.list(principal, parseInput(agentRoutes.listRuns.query, query));
  }

  @Get(':runId')
  @StaffRoute({ tenant: true, permission: 'analytics.read' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('runId') runId: string) {
    return this.runs.get(principal, runId);
  }
}
