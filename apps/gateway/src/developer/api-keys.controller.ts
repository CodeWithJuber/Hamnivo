import { CreateApiKeyRequest, RotateApiKeyRequest } from '@hamnivo/contracts';
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor, staffOf } from './actor.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * API keys (board 19, D01). Reading needs `api_keys.read`; creating, rotating and revoking need
 * `api_keys.manage` with two-step verification and a fresh sign-in, and are for people only.
 * The secret is in the response that creates or rotates a key, which is why these requests are
 * not idempotency-stored: a stored copy would be a second place the secret lives.
 */
@Controller('v1/admin/api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get()
  @ApiRoute({ permission: 'api_keys.read', tenantWide: true })
  async list(@CurrentActor() actor: Actor) {
    return { items: await this.keys.list(staffOf(actor)) };
  }

  @Get('permissions')
  @ApiRoute({ permission: 'api_keys.read', tenantWide: true })
  permissions(@CurrentActor() actor: Actor) {
    return { items: this.keys.permissionOptions(staffOf(actor)) };
  }

  @Post()
  @HttpCode(201)
  @ApiRoute({ permission: 'api_keys.manage', tenantWide: true })
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.keys.create(staffOf(actor), parseInput(CreateApiKeyRequest, body));
  }

  @Post(':id/rotate')
  @HttpCode(201)
  @ApiRoute({ permission: 'api_keys.manage', tenantWide: true })
  rotate(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.keys.rotate(staffOf(actor), id, parseInput(RotateApiKeyRequest, body ?? {}));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiRoute({ permission: 'api_keys.manage', tenantWide: true })
  revoke(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.keys.revoke(staffOf(actor), id);
  }
}

/** What the calling key is: lets an integration check its setup. */
@Controller('v1/api-keys')
export class CurrentApiKeyController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('current')
  @ApiRoute({ apiKey: true, staff: false })
  current(@CurrentActor() actor: Actor) {
    if (actor.kind !== 'api_key') throw new Error('unreachable: staff on an API-key route');
    return this.keys.identity(actor.tenantId, actor.keyId);
  }
}
