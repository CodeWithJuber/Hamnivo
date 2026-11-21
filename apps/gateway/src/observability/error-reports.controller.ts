import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CONFIG } from '../tokens.js';
import { type ErrorReportingSettings, envelopeTarget } from './error-reports.js';

/** Upstream headers the browser SDK reads to slow down when the tracker is busy. */
const PASSED_ON = ['retry-after', 'x-sentry-rate-limits'];

/**
 * Error reporting for Studio and the chat (see error-reports.ts). Public, like the chat's own
 * pages: an error can happen before anyone signs in. Each route also answers under /v1/widget/,
 * where the chat's origin may call it.
 */
@Controller('v1')
export class ErrorReportsController {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  @Get(['error-reporting', 'widget/error-reporting'])
  settings(): ErrorReportingSettings {
    return {
      dsn: this.config.SENTRY_DSN ?? null,
      environment: this.config.SENTRY_ENVIRONMENT ?? this.config.NODE_ENV,
      release: process.env.HAMNIVO_RELEASE?.trim() || null,
    };
  }

  @Post(['error-reports', 'widget/error-reports'])
  @HttpCode(200)
  async forward(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const dsn = this.config.SENTRY_DSN;
    if (!dsn) throw new AppError('NOT_FOUND', { detail: 'Error tracking is off on this server.' });
    const envelope = request.body;
    const target = typeof envelope === 'string' ? envelopeTarget(envelope, dsn) : null;
    if (!target || typeof envelope !== 'string') {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Send a Sentry envelope for this server’s own project.',
      });
    }
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/x-sentry-envelope' },
        body: envelope,
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      request.log.warn({ err: error }, 'error report not forwarded');
      throw new AppError('PROVIDER_UNAVAILABLE', { retryAfter: 60 });
    }
    // The browser SDK only needs to know whether to slow down; the tracker's body is not passed on.
    for (const name of PASSED_ON) {
      const value = upstream.headers.get(name);
      if (value) reply.header(name, value);
    }
    if (upstream.status === 429) {
      const retryAfter = Number(upstream.headers.get('retry-after'));
      throw new AppError('RATE_LIMITED', {
        retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      });
    }
    if (!upstream.ok) {
      request.log.warn({ status: upstream.status }, 'error tracker refused a report');
      throw new AppError('PROVIDER_UNAVAILABLE', { retryAfter: 60 });
    }
  }
}
