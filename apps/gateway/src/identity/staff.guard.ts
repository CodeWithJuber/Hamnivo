import { fromPublicId, InvalidPublicIdError } from '@hamnivo/db';
import {
  authorize,
  authorizeAny,
  authorizePlatform,
  type DenyReason,
  explain,
  type PlatformPermission,
} from '@hamnivo/policy';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { OperatorsService } from '../operations/operators.service.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { PrincipalService } from './principal.service.js';
import { PLATFORM_ROUTE, STAFF_ROUTE, type StaffRouteOptions } from './request-auth.js';

/** Turns a policy decision into the matching public error (MFA, step-up or plain denial). */
export function enforce(
  decision: { allowed: true } | { allowed: false; reason: DenyReason },
): void {
  if (decision.allowed) return;
  const explanation = explain(decision);
  const detail = explanation.allowed ? undefined : `${explanation.text} ${explanation.remedy}`;
  switch (decision.reason) {
    case 'mfa_required':
      throw new AppError('MFA_REQUIRED', { detail });
    case 'step_up_required':
      throw new AppError('REAUTH_REQUIRED', { detail });
    default:
      throw new AppError('SCOPE_DENIED', { detail });
  }
}

export function tenantIdFromHeader(request: FastifyRequest): string {
  const header = request.headers['x-hamnivo-tenant'];
  if (typeof header !== 'string' || header.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      fields: [{ path: 'X-Hamnivo-Tenant', message: 'Required' }],
    });
  }
  try {
    return fromPublicId('tenant', header);
  } catch (error) {
    if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
    throw error;
  }
}

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
    private readonly operators: OperatorsService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Platform console routes (A17): a platform operator, never a tenant role. */
  private async platform(
    context: ExecutionContext,
    options: { permission?: PlatformPermission },
  ): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const session = await this.principals.session(request);
    if (!session) throw new AppError('AUTH_REQUIRED');
    const operator = await this.operators.operator(session);
    // Not an operator (or no console configured): indistinguishable from a missing route.
    if (!operator) throw new AppError('NOT_FOUND');
    request.hamnivo = { session, operator };
    if (options.permission) {
      enforce(
        authorizePlatform(operator.principal, options.permission, {
          now: this.clock(),
          stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
        }),
      );
    }
    return true;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const platform = this.reflector.getAllAndOverride<
      { permission?: PlatformPermission } | undefined
    >(PLATFORM_ROUTE, targets);
    if (platform) return this.platform(context, platform);
    const options = this.reflector.getAllAndOverride<StaffRouteOptions | undefined>(
      STAFF_ROUTE,
      targets,
    );
    if (!options) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const session = await this.principals.session(request);
    if (!session) throw new AppError('AUTH_REQUIRED');
    request.hamnivo = { session };
    if (!options.tenant) return true;

    const tenantId = tenantIdFromHeader(request);
    const principal = await this.principals.principal(session, tenantId);
    // Not a member (or no such tenant): indistinguishable on purpose.
    if (!principal) throw new AppError('NOT_FOUND');
    request.hamnivo.principal = principal;

    if (options.permission) {
      const decisionOptions = {
        now: this.clock(),
        stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60_000,
      };
      enforce(
        options.tenantWide
          ? authorize(principal, options.permission, {}, decisionOptions)
          : authorizeAny(principal, options.permission, decisionOptions),
      );
    }
    return true;
  }
}
