import {
  CreateWidgetSessionRequest,
  FeedbackRequest,
  HandoffRequest,
  IdentifyRequest,
  ReadReceiptRequest,
  RefreshWidgetSessionRequest,
  SendMessageRequest,
  StartConversationRequest,
  widgetRoutes,
} from '@hamnivo/contracts';
import { fromPublicId, toPublicId } from '@hamnivo/db';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { countryOf } from '../visitors/privacy.js';
import { WidgetConversationsService } from './conversations.service.js';
import { WidgetEventsService } from './events.service.js';
import { WidgetSessionsService } from './sessions.service.js';
import type { WidgetClaims } from './tokens.service.js';
import { CurrentWidget, WidgetRoute } from './widget.guard.js';

/** Customer-facing widget API (blueprint §9, W05–W13). */
@Controller('v1/widget')
export class WidgetController {
  constructor(
    private readonly sessions: WidgetSessionsService,
    private readonly conversations: WidgetConversationsService,
    private readonly events: WidgetEventsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('sessions')
  @HttpCode(201)
  createSession(@Body() body: unknown, @Req() request: FastifyRequest) {
    const input = parseInput(CreateWidgetSessionRequest, body);
    return this.sessions.create({
      widgetId: input.widgetId,
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
      ...(input.hostOrigin && !input.direct ? { hostOrigin: input.hostOrigin } : {}),
      ...(input.test ? { test: true } : {}),
      ...(input.direct ? { direct: true } : {}),
      country: countryOf(request.headers),
    });
  }

  @Get('frame-policy')
  async framePolicy(@Query() query: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parseInput(widgetRoutes.framePolicy.query, query);
    const policy = await this.sessions.framePolicy(input.widgetId, input.test === '1');
    reply.header('x-hamnivo-frame-ancestors', policy.frameAncestors.join(' '));
    reply.header('cache-control', 'no-store');
    return policy;
  }

  @Post('sessions/refresh')
  @HttpCode(200)
  refresh(@Body() body: unknown, @Req() request: FastifyRequest) {
    return this.sessions.refresh(
      parseInput(RefreshWidgetSessionRequest, body).refreshToken,
      undefined,
      countryOf(request.headers),
    );
  }

  @Post('identity')
  @WidgetRoute()
  @HttpCode(200)
  identify(
    @CurrentWidget() claims: WidgetClaims,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.sessions.identify(
      claims,
      parseInput(IdentifyRequest, body).assertion,
      countryOf(request.headers),
    );
  }

  @Post('sessions/reset')
  @WidgetRoute()
  @HttpCode(204)
  async reset(@CurrentWidget() claims: WidgetClaims): Promise<void> {
    await this.sessions.reset(claims);
  }

  @Get('conversations')
  @WidgetRoute()
  async list(@CurrentWidget() claims: WidgetClaims) {
    return { items: await this.conversations.list(claims) };
  }

  @Post('conversations')
  @WidgetRoute()
  async start(
    @CurrentWidget() claims: WidgetClaims,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(StartConversationRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: claims.tenantId,
        actor: `customer:${toPublicId('customer', claims.principalId)}`,
        route: widgetRoutes.startConversation.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: input,
      },
      async () => ({
        status: 201,
        body: await this.conversations.start(claims, input, countryOf(request.headers)),
      }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get('conversations/:conversationId')
  @WidgetRoute()
  get(@CurrentWidget() claims: WidgetClaims, @Param('conversationId') conversationId: string) {
    return this.conversations.get(claims, conversationId);
  }

  @Get('conversations/:conversationId/messages')
  @WidgetRoute()
  history(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(widgetRoutes.listMessages.query, query);
    return this.conversations.history(claims, conversationId, {
      limit: input.limit,
      ...(input.before ? { before: input.before } : {}),
    });
  }

  @Post('conversations/:conversationId/messages')
  @WidgetRoute()
  @HttpCode(202)
  send(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.conversations.send(claims, conversationId, parseInput(SendMessageRequest, body));
  }

  @Post('conversations/:conversationId/read')
  @WidgetRoute()
  @HttpCode(204)
  async markRead(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const input = parseInput(ReadReceiptRequest, body);
    await this.conversations.markRead(claims, conversationId, input.upToSequence);
  }

  @Post('conversations/:conversationId/handoff')
  @WidgetRoute()
  @HttpCode(200)
  handoff(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const language = request.headers['accept-language']?.split(',')[0]?.split('-')[0];
    return this.conversations.handoff(
      claims,
      conversationId,
      parseInput(HandoffRequest, body),
      language,
    );
  }

  @Post('conversations/:conversationId/handoff/cancel')
  @WidgetRoute()
  @HttpCode(200)
  cancelHandoff(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Req() request: FastifyRequest,
  ) {
    const language = request.headers['accept-language']?.split(',')[0]?.split('-')[0];
    return this.conversations.cancelHandoff(claims, conversationId, language);
  }

  @Post('conversations/:conversationId/reply/stop')
  @WidgetRoute()
  @HttpCode(200)
  stopReply(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
  ) {
    return this.conversations.stopReply(claims, conversationId);
  }

  @Post('conversations/:conversationId/reopen')
  @WidgetRoute()
  @HttpCode(200)
  reopen(@CurrentWidget() claims: WidgetClaims, @Param('conversationId') conversationId: string) {
    return this.conversations.reopen(claims, conversationId);
  }

  @Post('conversations/:conversationId/feedback')
  @WidgetRoute()
  @HttpCode(204)
  async feedback(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.conversations.feedback(claims, conversationId, parseInput(FeedbackRequest, body));
  }

  @Get('conversations/:conversationId/events')
  @WidgetRoute()
  async stream(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const input = parseInput(widgetRoutes.events.query, query);
    const control = await this.conversations.head(claims, conversationId);
    const lastEventId = Number(request.headers['last-event-id']);
    const after =
      Number.isInteger(lastEventId) && lastEventId >= 0
        ? lastEventId
        : (input.after ?? control.journalSeq);
    await this.events.stream(
      request,
      reply,
      claims,
      fromPublicId('conversation', conversationId),
      after,
    );
  }

  @Get('conversations/:conversationId/events/poll')
  @WidgetRoute()
  async poll(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Query() query: unknown,
  ) {
    const input = parseInput(widgetRoutes.pollEvents.query, query);
    await this.conversations.head(claims, conversationId);
    return this.events.poll(
      claims,
      fromPublicId('conversation', conversationId),
      input.after,
      input.waitSeconds,
    );
  }
}
