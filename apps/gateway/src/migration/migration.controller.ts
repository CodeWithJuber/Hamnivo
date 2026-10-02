import {
  ApproveCutoverRequest,
  CreateMigrationExportRequest,
  CreateMigrationRequest,
  MigrationItemQuery,
  migrationRoutes,
  StartMigrationRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { MigrationService } from './migration.service.js';

@Controller('v1/admin/migrations')
export class MigrationController {
  constructor(
    private readonly migrations: MigrationService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async once<T>(
    principal: StaffPrincipal,
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
    body: unknown,
    work: () => Promise<T>,
  ) {
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body,
      },
      async () => ({ status: 202, body: await work() }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get('sources')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  sources() {
    return { items: this.migrations.sources() };
  }

  @Get()
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.migrations.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateMigrationRequest, body);
    return this.once(
      principal,
      request,
      reply,
      migrationRoutes.createMigration.operationId,
      input,
      () => this.migrations.create(principal, input),
    );
  }

  @Post('exports')
  @StaffRoute({ tenant: true, permission: 'conversations.export' })
  createExport(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateMigrationExportRequest, body);
    return this.once(
      principal,
      request,
      reply,
      migrationRoutes.createMigrationExport.operationId,
      input,
      () => this.migrations.createExport(principal, input.brandId),
    );
  }

  @Get(':migrationId')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  get(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.get(principal, id);
  }

  @Post(':migrationId/preflight')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  recheck(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.recheck(principal, id);
  }

  @Post(':migrationId/dry-run')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  dryRun(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.dryRun(principal, id);
  }

  @Post(':migrationId/start')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  start(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Body() body: unknown,
  ) {
    return this.migrations.start(principal, id, parseInput(StartMigrationRequest, body ?? {}));
  }

  @Post(':migrationId/pause')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  pause(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.pause(principal, id);
  }

  @Post(':migrationId/resume')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  resume(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.resume(principal, id);
  }

  @Post(':migrationId/cancel')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  cancel(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.cancel(principal, id);
  }

  @Post(':migrationId/retry')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.run' })
  retry(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.retry(principal, id);
  }

  @Post(':migrationId/rollback')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.manage' })
  rollback(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return this.migrations.rollback(principal, id);
  }

  @Post(':migrationId/cutover')
  @HttpCode(202)
  @StaffRoute({ tenant: true, permission: 'migration.manage' })
  cutover(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Body() body: unknown,
  ) {
    return this.migrations.cutover(principal, id, parseInput(ApproveCutoverRequest, body ?? {}));
  }

  @Get(':migrationId/items')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  items(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Query() query: unknown,
  ) {
    return this.migrations.items(principal, id, parseInput(MigrationItemQuery, query));
  }

  @Get(':migrationId/rejections')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  async rejections(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const csv = await this.migrations.rejections(principal, id);
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="migration-${id}-not-imported.csv"`);
    return csv;
  }

  @Get(':migrationId/reports')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  async reports(@CurrentPrincipal() principal: StaffPrincipal, @Param('migrationId') id: string) {
    return { items: await this.migrations.reports(principal, id) };
  }

  @Get(':migrationId/samples/:conversationId')
  @StaffRoute({ tenant: true, permission: 'migration.review' })
  sample(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.migrations.sample(principal, id, conversationId);
  }

  @Get(':migrationId/package')
  @StaffRoute({ tenant: true, permission: 'conversations.export' })
  async package(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('migrationId') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const file = await this.migrations.packageFile(principal, id);
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    return file.bytes;
  }
}
