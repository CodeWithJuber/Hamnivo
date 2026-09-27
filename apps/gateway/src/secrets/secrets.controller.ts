import { CreateSecretRequest, RotateSecretRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { SecretBroker } from './secret-broker.service.js';

@Controller('v1/admin/secrets')
export class SecretsController {
  constructor(
    private readonly broker: SecretBroker,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'secrets.manage', tenantWide: true })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.broker.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'secrets.manage', tenantWide: true })
  async create(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateSecretRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route: 'createSecret',
        key: validIdempotencyKey(request.headers['idempotency-key']),
        // Hash the request without keeping the secret value in the idempotency record.
        body: { kind: input.kind, label: input.label, value: `sha256:${input.value.length}` },
      },
      async () => ({ status: 201, body: await this.broker.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Post(':id/rotate')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'secrets.manage', tenantWide: true })
  rotate(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.broker.rotate(principal, id, parseInput(RotateSecretRequest, body).value);
  }

  @Delete(':id')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'secrets.manage', tenantWide: true })
  async revoke(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    await this.broker.revoke(principal, id);
  }
}
