import {
  CreateWebhookEndpointRequest,
  ReplayFailedRequest,
  RotateWebhookSecretRequest,
  UpdateWebhookEndpointRequest,
  WebhookEventType,
  webhookRoutes,
} from '@hamnivo/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { AppError } from '../common/app-error.js';
import { parseInput } from '../common/validation.js';
import { type Actor, ApiRoute, CurrentActor, staffOf } from './actor.js';
import { WebhookDeliveriesService } from './webhooks/deliveries.service.js';
import { WebhookEndpointsService } from './webhooks/endpoints.service.js';

const READ = { permission: 'webhooks.read', tenantWide: true, apiKey: true } as const;
const MANAGE = { permission: 'webhooks.manage', tenantWide: true } as const;

/**
 * Outgoing webhooks (D06). Reads accept an API key with `webhooks.read`; changes need
 * `webhooks.manage` and a fresh sign-in and are made by people.
 */
@Controller('v1/admin/webhooks')
export class WebhooksController {
  constructor(
    private readonly endpoints: WebhookEndpointsService,
    private readonly deliveries: WebhookDeliveriesService,
  ) {}

  @Get('event-types')
  @ApiRoute(READ)
  eventTypes() {
    return { items: this.deliveries.eventTypes() };
  }

  @Get('event-types/:type/sample')
  @ApiRoute(READ)
  sample(@CurrentActor() actor: Actor, @Param('type') type: string) {
    const parsed = WebhookEventType.safeParse(type);
    if (!parsed.success) throw new AppError('NOT_FOUND', { detail: 'No such event type.' });
    return this.deliveries.sample(parsed.data, actor.tenantId);
  }

  @Get('endpoints')
  @ApiRoute(READ)
  async list(@CurrentActor() actor: Actor) {
    return { items: await this.endpoints.list(actor.tenantId) };
  }

  @Post('endpoints')
  @HttpCode(201)
  @ApiRoute(MANAGE)
  create(@CurrentActor() actor: Actor, @Body() body: unknown) {
    return this.endpoints.create(staffOf(actor), parseInput(CreateWebhookEndpointRequest, body));
  }

  @Get('endpoints/:id')
  @ApiRoute(READ)
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.endpoints.get(actor.tenantId, id);
  }

  @Patch('endpoints/:id')
  @ApiRoute(MANAGE)
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.endpoints.update(
      staffOf(actor),
      id,
      parseInput(UpdateWebhookEndpointRequest, body),
    );
  }

  @Delete('endpoints/:id')
  @HttpCode(204)
  @ApiRoute(MANAGE)
  async remove(@CurrentActor() actor: Actor, @Param('id') id: string) {
    await this.endpoints.remove(staffOf(actor), id);
  }

  @Post('endpoints/:id/rotate-secret')
  @HttpCode(200)
  @ApiRoute(MANAGE)
  rotate(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.endpoints.rotateSecret(
      staffOf(actor),
      id,
      parseInput(RotateWebhookSecretRequest, body ?? {}),
    );
  }

  @Post('endpoints/:id/test')
  @HttpCode(200)
  @ApiRoute(MANAGE)
  test(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.endpoints.test(staffOf(actor), id);
  }

  @Post('endpoints/:id/replay-failed')
  @HttpCode(200)
  @ApiRoute(MANAGE)
  replayFailed(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: unknown) {
    return this.deliveries.replayFailed(staffOf(actor), id, parseInput(ReplayFailedRequest, body));
  }

  @Get('deliveries')
  @ApiRoute(READ)
  deliveriesList(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.deliveries.list(
      actor.tenantId,
      parseInput(webhookRoutes.listWebhookDeliveries.query, query),
    );
  }

  @Get('deliveries/:id')
  @ApiRoute(READ)
  delivery(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deliveries.detail(actor.tenantId, id);
  }

  @Post('deliveries/:id/replay')
  @HttpCode(201)
  @ApiRoute(MANAGE)
  replay(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deliveries.replay(staffOf(actor), id);
  }

  @Get('events')
  @ApiRoute(READ)
  events(@CurrentActor() actor: Actor, @Query() query: unknown) {
    return this.deliveries.events(
      actor.tenantId,
      parseInput(webhookRoutes.listWebhookEvents.query, query),
    );
  }
}
