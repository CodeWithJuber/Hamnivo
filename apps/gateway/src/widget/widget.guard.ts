import { type Db, schema, withTenant } from '@hamnivo/db';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import { assertWidgetOnline } from '../identity/tenants.readonly.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import { type WidgetClaims, WidgetTokens } from './tokens.service.js';

declare module 'fastify' {
  interface FastifyRequest {
    widget?: WidgetClaims;
  }
}

export const WIDGET_ROUTE = 'hamnivo:widget-route';
/** Requires a widget access token whose session is still active. */
export const WidgetRoute = () => SetMetadata(WIDGET_ROUTE, true);

export const CurrentWidget = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const claims = ctx.switchToHttp().getRequest<FastifyRequest>().widget;
  if (!claims) throw new Error('CurrentWidget used on a route without @WidgetRoute');
  return claims;
});

export function bearerOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
}

@Injectable()
export class WidgetGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: WidgetTokens,
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(WIDGET_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerOf(request);
    if (!token) throw new AppError('AUTH_REQUIRED', { detail: 'A widget session is required.' });
    const claims = await this.tokens.verify(token);
    // Revocation (sign-out, identity switch, refresh-token theft) applies on the next request.
    const [session] = await withTenant(this.db, { tenantId: claims.tenantId }, (tx) =>
      tx
        .select({
          revokedAt: schema.widgetSessions.revokedAt,
          expiresAt: schema.widgetSessions.expiresAt,
          tenantStatus: schema.tenants.status,
        })
        .from(schema.widgetSessions)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.widgetSessions.tenantId))
        .where(eq(schema.widgetSessions.id, claims.sessionId)),
    );
    if (!session || session.revokedAt || session.expiresAt <= this.clock()) {
      throw new AppError('SESSION_EXPIRED', { detail: 'This chat session has ended.' });
    }
    // A suspended workspace's chat is offline; a closed one's is gone.
    assertWidgetOnline(session.tenantStatus);
    request.widget = claims;
    return true;
  }
}
