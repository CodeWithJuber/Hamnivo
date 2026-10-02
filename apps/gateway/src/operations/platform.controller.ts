import {
  CreateIncidentRequest,
  platformRoutes,
  RequestSupportAccessRequest,
} from '@hamnivo/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentOperator, type OperatorContext, PlatformRoute } from '../identity/request-auth.js';
import { PlatformService } from './platform.service.js';
import { SupportSessionsService } from './support-sessions.service.js';

/**
 * The platform operations console (A17, board 26). Only platform operators get here; tenant
 * roles give no access. Reading a tenant's content needs a support grant it approved (A18).
 */
@Controller('v1/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly support: SupportSessionsService,
  ) {}

  @Get('me')
  @PlatformRoute()
  me(@CurrentOperator() operator: OperatorContext) {
    return this.platform.me(operator);
  }

  @Get('overview')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  overview() {
    return this.platform.overview();
  }

  @Get('tenants')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  async tenants(@Query() query: unknown) {
    const { query: text } = parseInput(platformRoutes.platformTenants.query, query);
    return { items: await this.platform.tenants(text) };
  }

  @Get('tenants/:id')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  tenant(@Param('id') id: string) {
    return this.platform.tenant(id);
  }

  @Get('health')
  @PlatformRoute({ permission: 'platform.health.read' })
  health() {
    return this.platform.health();
  }

  @Get('support-grants')
  @PlatformRoute({ permission: 'platform.support.request' })
  async supportGrants(@CurrentOperator() operator: OperatorContext) {
    return { items: await this.support.list(operator) };
  }

  @Post('support-grants')
  @PlatformRoute({ permission: 'platform.support.request' })
  request(@CurrentOperator() operator: OperatorContext, @Body() body: unknown) {
    return this.support.request(operator, parseInput(RequestSupportAccessRequest, body));
  }

  @Post('support-grants/:id/end')
  @HttpCode(200)
  @PlatformRoute({ permission: 'platform.support.request' })
  end(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.support.end(operator, id);
  }

  @Get('support-grants/:id/configuration')
  @PlatformRoute({ permission: 'platform.support.use' })
  configuration(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.support.configuration(operator, id);
  }

  @Get('support-grants/:id/conversations')
  @PlatformRoute({ permission: 'platform.support.use' })
  conversations(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.support.conversations(operator, id);
  }

  @Get('support-grants/:id/audit')
  @PlatformRoute({ permission: 'platform.support.use' })
  audit(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.support.audit(operator, id);
  }

  @Get('incidents')
  @PlatformRoute({ permission: 'platform.health.read' })
  async incidents() {
    return { items: await this.platform.incidents() };
  }

  @Post('incidents')
  @PlatformRoute({ permission: 'platform.incidents.manage' })
  declare(@CurrentOperator() operator: OperatorContext, @Body() body: unknown) {
    return this.platform.declareIncident(operator, parseInput(CreateIncidentRequest, body));
  }

  @Post('incidents/:id/resolve')
  @HttpCode(200)
  @PlatformRoute({ permission: 'platform.incidents.manage' })
  resolve(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.platform.resolveIncident(operator, id);
  }

  @Get('audit')
  @PlatformRoute({ permission: 'platform.audit.read' })
  async auditLog(@Query() query: unknown) {
    const { before, limit } = parseInput(platformRoutes.platformAudit.query, query);
    return this.platform.audit(before, limit);
  }
}
