import {
  LiveVisitorsQuery,
  VisitorInviteRequest,
  VisitorLinkRequest,
  VisitorSettings,
  VisitReport,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { CurrentWidget, WidgetRoute } from '../widget/widget.guard.js';
import { countryOf, privacyOptOut } from './privacy.js';
import { VisitorTracker } from './tracker.service.js';
import { VisitorsService } from './visitors.service.js';

/** The loader's body is JSON, sent as text/plain so the browser needs no CORS preflight. */
function jsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    throw new AppError('VALIDATION_FAILED', { detail: 'Send the report as JSON.' });
  }
}

/** What the chat loader and the chat widget send about a visitor's browser. */
@Controller('v1/widget')
export class VisitorsWidgetController {
  constructor(private readonly tracker: VisitorTracker) {}

  /**
   * Reported by the loader on a brand's website, so a browser on a website the brand did not allow
   * gets no CORS permission and cannot read the answer. Nothing is stored for a browser that
   * sends Do Not Track or Global Privacy Control.
   */
  @Post('visits')
  @HttpCode(200)
  async report(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(VisitReport, jsonBody(body));
    const { ack, origin } = await this.tracker.report(input, {
      origin: typeof request.headers.origin === 'string' ? request.headers.origin : undefined,
      optOut: privacyOptOut(request.headers),
      userAgent:
        typeof request.headers['user-agent'] === 'string'
          ? request.headers['user-agent']
          : undefined,
      country: countryOf(request.headers),
    });
    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('cache-control', 'no-store');
    return ack;
  }

  @Post('visitors/link')
  @WidgetRoute()
  @HttpCode(200)
  link(
    @CurrentWidget() claims: WidgetClaims,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    return this.tracker.link(claims, parseInput(VisitorLinkRequest, body), {
      optOut: privacyOptOut(request.headers),
    });
  }
}

/** Live visitors, the visitor card and the brand's visitor settings (Studio). */
@Controller('v1')
export class VisitorsController {
  constructor(private readonly visitors: VisitorsService) {}

  @Get('visitors/live')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  live(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.visitors.live(principal, parseInput(LiveVisitorsQuery, query));
  }

  @Post('visitors/:visitorId/invite')
  @StaffRoute({ tenant: true, permission: 'conversations.reply' })
  @HttpCode(202)
  invite(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('visitorId') visitorId: string,
    @Body() body: unknown,
  ) {
    return this.visitors.invite(
      principal,
      visitorId,
      parseInput(VisitorInviteRequest, body).message,
    );
  }

  @Get('inbox/conversations/:conversationId/visitor')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  conversationVisitor(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
  ) {
    return this.visitors.conversationVisitor(principal, conversationId);
  }

  @Get('admin/brands/:brandId/visitor-settings')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  getSettings(@CurrentPrincipal() principal: StaffPrincipal, @Param('brandId') brandId: string) {
    return this.visitors.getSettings(principal, brandId);
  }

  @Put('admin/brands/:brandId/visitor-settings')
  @StaffRoute({ tenant: true, permission: 'widget.configure' })
  updateSettings(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('brandId') brandId: string,
    @Body() body: unknown,
  ) {
    return this.visitors.updateSettings(principal, brandId, parseInput(VisitorSettings, body));
  }
}
