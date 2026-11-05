import { type ErrorCode, problem } from '@hamnivo/contracts';
import { InvalidPublicIdError } from '@hamnivo/db';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';
import { planLimitFromDatabase } from './plan-limit.js';

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'AUTH_REQUIRED',
  403: 'SCOPE_DENIED',
  404: 'NOT_FOUND',
  405: 'NOT_FOUND',
  409: 'VERSION_CONFLICT',
  413: 'UPLOAD_TOO_LARGE',
  415: 'VALIDATION_FAILED',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

export function toProblem(error: unknown, requestId: string) {
  // A malformed or foreign identifier is indistinguishable from a missing resource.
  if (error instanceof InvalidPublicIdError) return problem('NOT_FOUND', requestId);
  const appError = error instanceof AppError ? error : planLimitFromDatabase(error);
  if (appError) {
    const { detail, fields, retryAfter, retryable, quota, reason, currentOwner, aiDraft } =
      appError.details;
    return problem(appError.code, requestId, {
      ...(detail ? { detail } : {}),
      ...(fields ? { fields } : {}),
      ...(reason ? { reason } : {}),
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(quota ? { quota } : {}),
      ...(currentOwner ? { currentOwner } : {}),
      ...(aiDraft ? { aiDraft } : {}),
    });
  }
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : typeof (error as { statusCode?: unknown })?.statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
  const code = STATUS_TO_CODE[status] ?? 'INTERNAL';
  return problem(code, requestId);
}

/** Renders every error as `application/problem+json`; unexpected errors never leak details. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = toProblem(error, String(request.id));
    if (body.code === 'INTERNAL') {
      request.log.error({ err: error }, 'unhandled error');
    } else if (error instanceof AppError && error.details.internal) {
      request.log.warn({ internal: error.details.internal, code: body.code }, 'request rejected');
    }
    if (body.retryAfter) reply.header('retry-after', String(body.retryAfter));
    reply.status(body.status).header('content-type', 'application/problem+json').send(body);
  }
}
