import { fromPublicId, InvalidPublicIdError } from '@hamnivo/db';
import { authorize, authorizeAny, type Decision, explain } from '@hamnivo/policy';
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { CLOCK, type Clock, CONFIG } from '../tokens.js';
import { PrincipalService } from './principal.service.js';
import { STAFF_ROUTE, type StaffRouteOptions } from './request-auth.js';

/** Turns a policy decision into the matching public error (MFA, step-up or plain denial). */
export function enforce(decision: Decision): void {
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
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<StaffRouteOptions | undefined>(STAFF_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
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
