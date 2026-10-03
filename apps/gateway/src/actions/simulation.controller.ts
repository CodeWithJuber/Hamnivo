import { SaveSimulationSuiteRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { SimulationService } from './simulation.service.js';

/** Simulation suites and runs of an agent (G11), on the agent's Test tab in Studio. */
@Controller('v1/admin/agents/:agentId/simulations')
export class SimulationsController {
  constructor(private readonly simulations: SimulationService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Param('agentId') agentId: string) {
    return { items: await this.simulations.listSuites(principal, agentId) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ) {
    return this.simulations.saveSuite(
      principal,
      agentId,
      null,
      parseInput(SaveSimulationSuiteRequest, body),
    );
  }

  @Put(':suiteId')
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Param('suiteId') suiteId: string,
    @Body() body: unknown,
  ) {
    return this.simulations.saveSuite(
      principal,
      agentId,
      suiteId,
      parseInput(SaveSimulationSuiteRequest, body),
    );
  }

  @Delete(':suiteId')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  async remove(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Param('suiteId') suiteId: string,
  ) {
    await this.simulations.deleteSuite(principal, agentId, suiteId);
  }

  @Post(':suiteId/runs')
  @StaffRoute({ tenant: true, permission: 'agents.manage' })
  run(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Param('suiteId') suiteId: string,
  ) {
    return this.simulations.run(principal, agentId, suiteId);
  }

  @Get(':suiteId/runs')
  @StaffRoute({ tenant: true, permission: 'agents.read' })
  async runs(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('agentId') agentId: string,
    @Param('suiteId') suiteId: string,
  ) {
    return { items: await this.simulations.listRuns(principal, agentId, suiteId) };
  }
}
