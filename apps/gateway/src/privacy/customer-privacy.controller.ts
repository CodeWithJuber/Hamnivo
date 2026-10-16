import {
  EraseCustomerRequest,
  ExportCustomerRequest,
  PrivacyCustomersQuery,
  privacyRoutes,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, Header, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { CustomerPrivacyService } from './customer-privacy.service.js';

/** One customer's data on request: find, export, erase (A10). Brands are checked in the service. */
@Controller('v1/admin/privacy')
export class CustomerPrivacyController {
  constructor(
    private readonly privacy: CustomerPrivacyService,
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

  @Get('customers')
  @StaffRoute({ tenant: true })
  @Header('cache-control', 'no-store')
  find(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.privacy.search(principal, parseInput(PrivacyCustomersQuery, query));
  }

  @Get('customers/:customerId')
  @StaffRoute({ tenant: true })
  @Header('cache-control', 'no-store')
  customer(@CurrentPrincipal() principal: StaffPrincipal, @Param('customerId') id: string) {
    return this.privacy.summary(principal, id);
  }

  @Post('customers/:customerId/export')
  @StaffRoute({ tenant: true, permission: 'customers.export' })
  export(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('customerId') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(ExportCustomerRequest, body);
    return this.once(
      principal,
      request,
      reply,
      privacyRoutes.exportPrivacyCustomer.operationId,
      { id, ...input },
      () => this.privacy.requestExport(principal, id, input),
    );
  }

  @Post('customers/:customerId/erase')
  @StaffRoute({ tenant: true, permission: 'customers.erase' })
  erase(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('customerId') id: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(EraseCustomerRequest, body);
    return this.once(
      principal,
      request,
      reply,
      privacyRoutes.erasePrivacyCustomer.operationId,
      { id, ...input },
      () => this.privacy.requestErase(principal, id, input),
    );
  }

  @Get('requests')
  @StaffRoute({ tenant: true })
  @Header('cache-control', 'no-store')
  requests(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.privacy.list(principal);
  }

  @Get('requests/:requestId')
  @StaffRoute({ tenant: true })
  @Header('cache-control', 'no-store')
  request(@CurrentPrincipal() principal: StaffPrincipal, @Param('requestId') id: string) {
    return this.privacy.get(principal, id);
  }

  @Get('requests/:requestId/file')
  @StaffRoute({ tenant: true, permission: 'customers.export' })
  async file(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('requestId') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const file = await this.privacy.file(principal, id);
    reply.header('content-type', 'application/zip');
    reply.header('cache-control', 'no-store');
    reply.header('content-disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    return file.bytes;
  }
}
