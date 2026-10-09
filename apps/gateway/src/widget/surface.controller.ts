import {
  ConsentRequest,
  customerSurfaceWidgetRoutes,
  OfflineMessageRequest,
  ReactionRequest,
  UpdateNotificationPreferencesRequest,
  widgetRoutes,
} from '@hamnivo/contracts';
import { toPublicId } from '@hamnivo/db';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { countryOf } from '../visitors/privacy.js';
import { WidgetAttachmentsService } from './attachments.service.js';
import { WidgetConsentService } from './consent.js';
import { WidgetHelpService } from './help.service.js';
import { WidgetMessagesService } from './messages.service.js';
import { WidgetNotificationsService } from './notifications.service.js';
import { OfflineMessagesService } from './offline-messages.service.js';
import { WidgetSessionsService } from './sessions.service.js';
import { TicketEmailsService } from './ticket-emails.service.js';
import type { WidgetClaims } from './tokens.service.js';
import { CurrentWidget, WidgetRoute } from './widget.guard.js';

/** RFC 5987 filename for Content-Disposition, with a plain ASCII fallback. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The customer surface of the widget API: the loader's configuration (W02, W19), files (W09),
 * deleting one's own message (W23), reactions (W22), help search (W17) and email choices (W25).
 */
@Controller('v1/widget')
export class WidgetSurfaceController {
  constructor(
    private readonly sessions: WidgetSessionsService,
    private readonly attachments: WidgetAttachmentsService,
    private readonly messages: WidgetMessagesService,
    private readonly help: WidgetHelpService,
    private readonly notifications: WidgetNotificationsService,
    private readonly consent: WidgetConsentService,
    private readonly offline: OfflineMessagesService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** "I agree" to the brand's words before chatting (W27). */
  @Post('consent')
  @WidgetRoute()
  @HttpCode(204)
  async giveConsent(@CurrentWidget() claims: WidgetClaims, @Body() body: unknown): Promise<void> {
    await this.consent.give(claims, parseInput(ConsentRequest, body).noticeVersion);
  }

  /** The contact form while nobody can answer (W11): a ticket, once per request id. */
  @Post('offline-messages')
  @WidgetRoute()
  async sendOfflineMessage(
    @CurrentWidget() claims: WidgetClaims,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(OfflineMessageRequest, body);
    const result = await this.idempotency.run(
      {
        tenantId: claims.tenantId,
        actor: `customer:${toPublicId('customer', claims.principalId)}`,
        route: customerSurfaceWidgetRoutes.sendOfflineMessage.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key'] ?? input.clientRequestId),
        body: input,
      },
      async () => ({
        status: 201,
        body: await this.offline.send(claims, input, countryOf(request.headers)),
      }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  /**
   * Read by the loader on the brand's website, before the chat loads. A browser on a website the
   * brand did not allow gets no CORS permission, so the page cannot read it.
   */
  @Get('launcher')
  async launcher(
    @Query() query: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(customerSurfaceWidgetRoutes.launcherConfig.query, query);
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const config = await this.sessions.launcher(
      input.widgetId,
      origin,
      input.locale,
      countryOf(request.headers),
    );
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    // The prompts depend on this visitor's country and who is online: never a shared cache.
    reply.header('cache-control', 'private, max-age=60');
    return config;
  }

  @Post('conversations/:conversationId/uploads')
  @WidgetRoute()
  @HttpCode(201)
  upload(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Query() query: unknown,
    @Req() request: FastifyRequest,
  ) {
    const input = parseInput(widgetRoutes.uploadAttachment.query, query);
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Send the file’s bytes with Content-Type: application/octet-stream.',
      });
    }
    return this.attachments.upload(claims, conversationId, input.name, request.body);
  }

  @Get('conversations/:conversationId/attachments/:attachmentId')
  @WidgetRoute()
  async download(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.attachments.download(claims, conversationId, attachmentId);
    await reply
      .status(200)
      .header('content-type', file.contentType)
      .header('content-disposition', disposition(file.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(file.bytes));
  }

  @Post('conversations/:conversationId/messages/:messageId/delete')
  @WidgetRoute()
  @HttpCode(200)
  deleteMessage(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.delete(claims, conversationId, messageId);
  }

  @Post('conversations/:conversationId/messages/:messageId/reactions')
  @WidgetRoute()
  @HttpCode(202)
  react(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.messages.react(
      claims,
      conversationId,
      messageId,
      parseInput(ReactionRequest, body),
    );
  }

  @Get('help/search')
  @WidgetRoute()
  @Header('cache-control', 'private, no-store')
  searchHelp(@CurrentWidget() claims: WidgetClaims, @Query() query: unknown) {
    const input = parseInput(customerSurfaceWidgetRoutes.helpSearch.query, query);
    return this.help.search(claims, input.q);
  }

  @Get('notifications')
  @WidgetRoute()
  getNotifications(@CurrentWidget() claims: WidgetClaims) {
    return this.notifications.get(claims);
  }

  @Post('notifications')
  @WidgetRoute()
  @HttpCode(200)
  updateNotifications(@CurrentWidget() claims: WidgetClaims, @Body() body: unknown) {
    return this.notifications.update(
      claims,
      parseInput(UpdateNotificationPreferencesRequest, body),
    );
  }
}

/** Unsubscribe links in customer emails (W25): a signed token and no session. */
@Controller('v1/notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: WidgetNotificationsService,
    private readonly tickets: TicketEmailsService,
  ) {}

  private async send(reply: FastifyReply, page: { status: number; html: string }) {
    await reply
      .status(page.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send(page.html);
  }

  @Get('unsubscribe')
  async page(@Query('token') token: unknown, @Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, await this.notifications.confirmPage(String(token ?? '')));
  }

  /** The confirmation button, and mail clients' one-click unsubscribe (RFC 8058). */
  @Post('unsubscribe')
  async unsubscribe(@Query('token') token: unknown, @Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, await this.notifications.unsubscribe(String(token ?? '')));
  }

  /** The page a ticket's confirmation link opens (W11, H19): it asks before confirming. */
  @Get('confirm-email')
  async confirmEmailPage(@Query('token') token: unknown, @Res() reply: FastifyReply) {
    await this.send(reply, await this.tickets.confirmPage(String(token ?? '')));
  }

  @Post('confirm-email')
  async confirmEmail(@Query('token') token: unknown, @Res() reply: FastifyReply) {
    await this.send(reply, await this.tickets.confirm(String(token ?? '')));
  }
}
