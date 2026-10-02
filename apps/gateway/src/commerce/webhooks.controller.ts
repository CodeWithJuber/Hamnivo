import type { RawBodyRequest } from '@nestjs/common';
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CommerceWebhooksService } from './webhooks.service.js';

/** Payment-provider webhooks for one merchant connection (Stripe-signed). */
@Controller('v1/integrations/commerce')
export class CommerceWebhooksController {
  constructor(private readonly webhooks: CommerceWebhooksService) {}

  @Post(':merchantId/webhook')
  @HttpCode(200)
  async receive(
    @Param('merchantId') merchantId: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: true }> {
    await this.webhooks.receive({
      merchantPublicId: merchantId,
      headers: request.headers,
      rawBody: request.rawBody,
    });
    return { received: true };
  }
}
