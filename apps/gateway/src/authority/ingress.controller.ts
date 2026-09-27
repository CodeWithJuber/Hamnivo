import type { RawBodyRequest } from '@nestjs/common';
import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { IngressService, type WebhookSource } from './ingress.service.js';

const SOURCES = new Set<WebhookSource>(['account', 'inbox', 'bot']);

@Controller('v1/integrations/chatwoot')
export class ChatwootIngressController {
  constructor(private readonly ingress: IngressService) {}

  @Post(':connectionId/:source')
  @HttpCode(204)
  async receive(
    @Param('connectionId') connectionId: string,
    @Param('source') source: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<void> {
    if (!SOURCES.has(source as WebhookSource)) throw new AppError('NOT_FOUND');
    await this.ingress.receive({
      connectionPublicId: connectionId,
      source: source as WebhookSource,
      headers: request.headers,
      rawBody: request.rawBody,
    });
  }
}
