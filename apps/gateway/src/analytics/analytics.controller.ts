import { AnalyticsQuery } from '@hamnivo/contracts';
import { Controller, Get, Header, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor } from '../developer/actor.js';
import { AnalyticsService } from './analytics.service.js';

const READ = { permission: 'analytics.read', apiKey: true } as const;

/** Product analytics (O04, board 23): any `analytics.read` grant sees its own part. */
@Controller('v1/admin/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @ApiRoute(READ)
  overview(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.analytics.overview(actor.principal, parseInput(AnalyticsQuery, query));
  }

  @Get('export')
  @ApiRoute(READ)
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="hamnivo-analytics.csv"')
  @Header('cache-control', 'no-store')
  export(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.analytics.csv(actor.principal, parseInput(AnalyticsQuery, query));
  }
}
