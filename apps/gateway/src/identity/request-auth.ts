import type {
  Permission,
  PlatformPermission,
  PlatformPrincipal,
  StaffPrincipal,
} from '@hamnivo/policy';
import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { AuthSession } from './auth.factory.js';

/** A platform operator (A17), with what the console shows about them. */
export interface OperatorContext {
  principal: PlatformPrincipal;
  name: string;
  email: string;
}

export interface RequestAuth {
  session: AuthSession;
  principal?: StaffPrincipal;
  operator?: OperatorContext;
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

export const PLATFORM_ROUTE = 'hamnivo:platform-route';

/**
 * Marks a handler of the platform console (A17): a signed-in platform operator, optionally with a
 * platform permission. Tenant roles give no access here.
 */
export const PlatformRoute = (options: { permission?: PlatformPermission } = {}) =>
  SetMetadata(PLATFORM_ROUTE, options);

export const CurrentOperator = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const operator = ctx.switchToHttp().getRequest<FastifyRequest>().hamnivo?.operator;
  if (!operator) throw new Error('CurrentOperator used on a route without @PlatformRoute');
  return operator;
});

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
