import { LIVE_DATA_CACHE_CONTROL } from '@hamnivo/domain/commerce';
import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Observable } from 'rxjs';

/**
 * Prices, stock, payment and order state are live data (K06): no response about them may be
 * stored by a browser or proxy, errors included, so the header is set before the handler runs.
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('cache-control', LIVE_DATA_CACHE_CONTROL);
    return next.handle();
  }
}
