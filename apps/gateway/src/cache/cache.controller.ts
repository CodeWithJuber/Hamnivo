import {
  cacheRoutes,
  InspectCacheRequest,
  InvalidateCacheRequest,
  UpdateCachePolicyRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { CacheAdminService } from './admin.service.js';

/**
 * Answer and NLP caching of a brand (board 25). Handlers check the brand permission themselves:
 * `knowledge.read` to look, `knowledge.manage` to change the policy or invalidate.
 */
@Controller('v1/admin/brands/:brandId/cache')
export class CacheController {
  constructor(private readonly admin: CacheAdminService) {}

  @Get('policy')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  policy(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.admin.policy(principal, brandId);
  }

  @Put('policy')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  updatePolicy(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.admin.updatePolicy(principal, brandId, parseInput(UpdateCachePolicyRequest, body));
  }

  @Post('inspect')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  inspect(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.admin.inspect(principal, brandId, parseInput(InspectCacheRequest, body));
  }

  @Get('entries')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async entries(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(cacheRoutes.listCacheEntries.query, query);
    return { items: await this.admin.entries(principal, brandId, input) };
  }

  @Get('impact')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  impact(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(cacheRoutes.getCacheImpact.query, query);
    return this.admin.impact(principal, brandId, input.sourceId);
  }

  @Post('invalidate')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  invalidate(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.admin.invalidate(principal, brandId, parseInput(InvalidateCacheRequest, body));
  }

  @Get('metrics')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  metrics(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(cacheRoutes.getCacheMetrics.query, query);
    return this.admin.metrics(principal, brandId, input.days);
  }
}
