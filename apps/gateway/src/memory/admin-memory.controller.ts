import {
  adminMemoryRoutes,
  EraseCustomerMemoryRequest,
  MemoryReasonRequest,
  StaffCorrectMemoryRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AdminMemoryService } from './admin-memory.service.js';

/**
 * Customer memory in Studio (L04, L05). The route permission is checked for the person's grants
 * somewhere in the tenant; each action then checks it for the customer's own brand. Responses
 * are personal and never cached (K09).
 */
@Controller('v1/admin/memory')
export class AdminMemoryController {
  constructor(private readonly memory: AdminMemoryService) {}

  @Get('customers')
  @StaffRoute({ tenant: true, permission: 'memory.read' })
  @Header('cache-control', 'no-store')
  async list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(adminMemoryRoutes.listMemoryCustomers.query, query);
    return { items: await this.memory.list(principal, input) };
  }

  @Get('customers/:customerId')
  @StaffRoute({ tenant: true, permission: 'memory.read' })
  @Header('cache-control', 'no-store')
  detail(@CurrentPrincipal() principal: StaffPrincipal, @Param('customerId') customerId: string) {
    return this.memory.detail(principal, customerId);
  }

  @Get('customers/:customerId/export')
  @StaffRoute({ tenant: true, permission: 'memory.export' })
  @Header('cache-control', 'no-store')
  export(@CurrentPrincipal() principal: StaffPrincipal, @Param('customerId') customerId: string) {
    return this.memory.export(principal, customerId);
  }

  @Post('customers/:customerId/erase')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'memory.erase' })
  @Header('cache-control', 'no-store')
  erase(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    return this.memory.erase(principal, customerId, parseInput(EraseCustomerMemoryRequest, body));
  }

  @Post('records/:memoryId/correct')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'memory.manage' })
  @Header('cache-control', 'no-store')
  correct(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.correct(principal, memoryId, parseInput(StaffCorrectMemoryRequest, body));
  }

  @Post('records/:memoryId/confirm')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'memory.manage' })
  @Header('cache-control', 'no-store')
  confirm(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.confirm(principal, memoryId, parseInput(MemoryReasonRequest, body).reason);
  }

  @Post('records/:memoryId/outdated')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'memory.manage' })
  @Header('cache-control', 'no-store')
  outdated(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.outdate(principal, memoryId, parseInput(MemoryReasonRequest, body).reason);
  }

  @Post('records/:memoryId/reject')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'memory.manage' })
  @Header('cache-control', 'no-store')
  reject(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.reject(principal, memoryId, parseInput(MemoryReasonRequest, body).reason);
  }

  @Post('records/:memoryId/delete')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'memory.delete' })
  @Header('cache-control', 'no-store')
  delete(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('memoryId') memoryId: string,
    @Body() body: unknown,
  ) {
    return this.memory.delete(principal, memoryId, parseInput(MemoryReasonRequest, body).reason);
  }

  @Get('deletions/:deletionId')
  @StaffRoute({ tenant: true, permission: 'memory.read' })
  @Header('cache-control', 'no-store')
  deletion(@CurrentPrincipal() principal: StaffPrincipal, @Param('deletionId') deletionId: string) {
    return this.memory.deletion(principal, deletionId);
  }
}
