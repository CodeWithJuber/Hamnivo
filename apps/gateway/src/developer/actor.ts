import { toPublicId } from '@hamnivo/db';
import {
  authorize,
  authorizeAny,
  type Decision,
  type Permission,
  type Principal,
  type ServiceAccountPrincipal,
  type StaffPrincipal,
} from '@hamnivo/policy';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { PrincipalService } from '../identity/principal.service.js';
import { enforce, principalForRequest, tenantIdFromHeader } from '../identity/staff.guard.js';
import { assertWritable } from '../identity/tenants.readonly.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { ApiKeysService } from './api-keys.service.js';
import { bearerApiKey } from './keys.js';
import { ApiKeyRateLimiter } from './rate-limit.js';

/**
 * Who is calling a developer-platform route: a signed-in staff member in a tenant, or an API key
 * acting as its service account in the key's own tenant.
 */
export type Actor =
  | { kind: 'staff'; tenantId: string; principal: StaffPrincipal; actorId: string }
  | {
      kind: 'api_key';
      tenantId: string;
      principal: ServiceAccountPrincipal;
      keyId: string;
      actorId: string;
    };

declare module 'fastify' {
  interface FastifyRequest {
    hamnivoActor?: Actor;
  }
}

export const API_ROUTE = 'hamnivo:api-route';

export interface ApiRouteOptions {
  /** One permission, or several of which any one is enough. Omitted: any authenticated caller. */
  permission?: Permission | readonly Permission[];
  /** The permission must be held at tenant scope. */
  tenantWide?: boolean;
  /** Accept an API key (`Authorization: Bearer hv_live_…`). */
  apiKey?: boolean;
  /** Accept a staff session (default true). */
  staff?: boolean;
}

/** Marks a route of the developer platform and says who may call it. */
export const ApiRoute = (options: ApiRouteOptions) => SetMetadata(API_ROUTE, options);

export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext) => {
  const actor = ctx.switchToHttp().getRequest<FastifyRequest>().hamnivoActor;
  if (!actor) throw new Error('CurrentActor used on a route without @ApiRoute');
  return actor;
});

/** The staff member behind an actor, for actions only people may take. */
export function staffOf(actor: Actor): StaffPrincipal {
  if (actor.kind !== 'staff') throw new AppError('SCOPE_DENIED');
  return actor.principal;
}

export function decide(
  principal: Principal,
  permission: Permission,
  options: { tenantWide?: boolean; now: Date; stepUpMaxAgeMs: number },
): Decision {
  const settings = { now: options.now, stepUpMaxAgeMs: options.stepUpMaxAgeMs };
  return options.tenantWide
    ? authorize(principal, permission, {}, settings)
    : authorizeAny(principal, permission, settings);
}

@Injectable()
export class ActorGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
    private readonly keys: ApiKeysService,
    private readonly limiter: ApiKeyRateLimiter,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<ApiRouteOptions | undefined>(API_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const presented = bearerApiKey(request.headers.authorization);
    const actor = presented
      ? await this.fromKey(presented, request, options)
      : await this.fromSession(request, options);
    request.hamnivoActor = actor;
    const permissions = options.permission
      ? ((Array.isArray(options.permission)
          ? options.permission
          : [options.permission]) as Permission[])
      : [];
    if (permissions.length > 0) {
      const settings = {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        ...(options.tenantWide ? { tenantWide: true } : {}),
      };
      const decisions = permissions.map((p) => decide(actor.principal, p, settings));
      const granted = decisions.find((d) => d.allowed);
      if (!granted) enforce(decisions[0] as Decision);
    }
    return true;
  }

  private async fromKey(
    presented: string,
    request: FastifyRequest,
    options: ApiRouteOptions,
  ): Promise<Actor> {
    if (!options.apiKey) {
      throw new AppError('AUTH_REQUIRED', {
        detail: 'This action needs a signed-in person; API keys are not accepted here.',
      });
    }
    const authenticated = await this.keys.authenticate(presented);
    await this.limiter.check(authenticated.keyId);
    // A tenant header, when sent, must name the key's own tenant.
    const header = request.headers['x-hamnivo-tenant'];
    if (typeof header === 'string' && header.length > 0) {
      if (tenantIdFromHeader(request) !== authenticated.principal.tenantId) {
        throw new AppError('NOT_FOUND');
      }
    }
    return {
      kind: 'api_key',
      tenantId: authenticated.principal.tenantId,
      principal: authenticated.principal,
      keyId: authenticated.keyId,
      actorId: toPublicId('apiKey', authenticated.keyId),
    };
  }

  private async fromSession(request: FastifyRequest, options: ApiRouteOptions): Promise<Actor> {
    if (options.staff === false) {
      throw new AppError('AUTH_REQUIRED', { detail: 'Send an API key: Authorization: Bearer …' });
    }
    const session = await this.principals.session(request);
    if (!session) throw new AppError('AUTH_REQUIRED');
    const tenantId = tenantIdFromHeader(request);
    const member = await this.principals.principal(session, tenantId);
    // Not a member (or no such tenant): indistinguishable on purpose.
    if (!member) throw new AppError('NOT_FOUND');
    assertWritable(member, request);
    // Reads need no recent sign-in here either (GET /v1/admin/network/egress, the webhook log).
    const principal = principalForRequest(member, request);
    request.hamnivo = { session, principal };
    return {
      kind: 'staff',
      tenantId,
      principal,
      actorId: toPublicId('staff', principal.staffMemberId),
    };
  }
}
