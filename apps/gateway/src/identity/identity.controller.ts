import { AcceptInvitationRequest, CreateTenantRequest, type Me } from '@hamnivo/contracts';
import { type Db, resolveStaffMemberships, toPublicId } from '@hamnivo/db';
import { effectivePermissions } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AdminService } from '../admin/admin.service.js';
import { validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { APP_DB, CLOCK, type Clock } from '../tokens.js';
import type { AuthSession } from './auth.factory.js';
import { PrincipalService } from './principal.service.js';
import { CurrentSession, StaffRoute } from './request-auth.js';
import { tenantIdFromHeader } from './staff.guard.js';
import { TenantsService } from './tenants.service.js';

@Controller('v1')
export class IdentityController {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly principals: PrincipalService,
    private readonly tenants: TenantsService,
    private readonly admin: AdminService,
  ) {}

  @Get('me')
  @StaffRoute({ tenant: false })
  async me(
    @CurrentSession() session: AuthSession,
    @Req() request: FastifyRequest,
  ): Promise<z.infer<typeof Me>> {
    const memberships = await resolveStaffMemberships(this.db, session.user.id);
    let current: z.infer<typeof Me>['current'] = null;
    if (request.headers['x-hamnivo-tenant']) {
      const principal = await this.principals.principal(session, tenantIdFromHeader(request));
      if (principal) {
        current = {
          tenantId: toPublicId('tenant', principal.tenantId),
          staffMemberId: toPublicId('staff', principal.staffMemberId),
          permissions: [...effectivePermissions(principal, this.clock())].sort(),
          mfa: principal.mfa,
        };
      }
    }
    const user = session.user as typeof session.user & { twoFactorEnabled?: boolean | null };
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        twoFactorEnabled: Boolean(user.twoFactorEnabled),
      },
      memberships: memberships.map((m) => ({
        tenant: {
          id: toPublicId('tenant', m.tenantId),
          slug: m.tenantSlug,
          name: m.tenantName,
          status: m.tenantStatus as 'active' | 'suspended' | 'closing',
        },
        staffMemberId: toPublicId('staff', m.staffMemberId),
        status: m.staffStatus as 'invited' | 'active' | 'suspended' | 'removed',
      })),
      current,
    };
  }

  @Post('tenants')
  @StaffRoute({ tenant: false })
  async createTenant(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateTenantRequest, body);
    const key = validIdempotencyKey(request.headers['idempotency-key']);
    const { membership, replayed } = await this.tenants.create(session, input, key);
    reply.status(201);
    if (replayed) reply.header('idempotent-replayed', 'true');
    return membership;
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @StaffRoute({ tenant: false })
  async accept(@CurrentSession() session: AuthSession, @Body() body: unknown) {
    const { token } = parseInput(AcceptInvitationRequest, body);
    return this.admin.acceptInvitation(session, token);
  }
}
