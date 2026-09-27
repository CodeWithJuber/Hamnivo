import type { Permission, StaffPrincipal } from '@hamnivo/policy';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthSession } from './auth.factory.js';

export interface RequestAuth {
  session: AuthSession;
  principal?: StaffPrincipal;
}

declare module 'fastify' {
  interface FastifyRequest {
    hamnivo?: RequestAuth;
  }
}

export const STAFF_ROUTE = 'hamnivo:staff-route';

export interface StaffRouteOptions {
  /** Requires X-Hamnivo-Tenant and an active membership there. */
  tenant: boolean;
  /** Permission the person must hold somewhere in the tenant (resource checks follow in code). */
  permission?: Permission;
  /**
   * The route reads or changes tenant-wide data, so the permission must be held at tenant scope
   * (a workspace- or team-scoped grant is not enough).
   */
  tenantWide?: boolean;
}

/** Marks a handler as requiring a signed-in staff member (and optionally a tenant permission). */
export const StaffRoute = (options: StaffRouteOptions) => SetMetadata(STAFF_ROUTE, options);

export const CurrentSession = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<FastifyRequest>().hamnivo;
  if (!auth) throw new Error('CurrentSession used on a route without @StaffRoute');
  return auth.session;
});

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const principal = ctx.switchToHttp().getRequest<FastifyRequest>().hamnivo?.principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without a tenant');
  return principal;
});

export const RequestId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<FastifyRequest>().id as string,
);
