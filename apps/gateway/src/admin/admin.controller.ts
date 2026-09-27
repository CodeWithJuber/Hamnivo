import {
  CreateGrantRequest,
  CreateInvitationRequest,
  CreateRoleRequest,
  RevokeGrantRequest,
  UpdateMemberRequest,
  UpdateRoleRequest,
} from '@hamnivo/contracts';
import { PERMISSION_KEYS, PERMISSIONS, type StaffPrincipal } from '@hamnivo/policy';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { AdminService } from './admin.service.js';

@Controller('v1/admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async idempotent<T>(
    principal: StaffPrincipal,
    route: string,
    request: FastifyRequest,
    reply: FastifyReply,
    body: unknown,
    run: () => Promise<T>,
  ): Promise<T> {
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body,
      },
      async () => ({ status: 201, body: await run() }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get('permissions')
  @StaffRoute({ tenant: true })
  permissions() {
    return {
      items: PERMISSION_KEYS.map((key) => {
        const spec = PERMISSIONS[key];
        return {
          key,
          description: spec.description,
          scopes: [...spec.scopes],
          stepUp: 'stepUp' in spec && spec.stepUp === true,
          mfa: 'mfa' in spec && spec.mfa === true,
        };
      }),
    };
  }

  @Get('workspaces')
  @StaffRoute({ tenant: true, permission: 'members.read' })
  async workspaces(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.admin.listWorkspaces(principal) };
  }

  @Get('members')
  @StaffRoute({ tenant: true, permission: 'members.read' })
  async members(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.admin.listMembers(principal) };
  }

  @Patch('members/:id')
  @StaffRoute({ tenant: true, permission: 'members.remove', tenantWide: true })
  updateMember(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateMember(principal, id, parseInput(UpdateMemberRequest, body));
  }

  @Get('invitations')
  @StaffRoute({ tenant: true, permission: 'members.read' })
  async invitations(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.admin.listInvitations(principal) };
  }

  @Post('invitations')
  @StaffRoute({ tenant: true, permission: 'members.invite' })
  createInvitation(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateInvitationRequest, body);
    return this.idempotent(principal, 'createInvitation', request, reply, input, () =>
      this.admin.createInvitation(principal, input),
    );
  }

  @Delete('invitations/:id')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'members.invite' })
  async revokeInvitation(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    await this.admin.revokeInvitation(principal, id);
  }

  @Get('roles')
  @StaffRoute({ tenant: true, permission: 'members.read' })
  async roles(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.admin.listRoles(principal) };
  }

  @Post('roles')
  @StaffRoute({ tenant: true, permission: 'roles.manage' })
  createRole(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateRoleRequest, body);
    return this.idempotent(principal, 'createRole', request, reply, input, () =>
      this.admin.createRole(principal, input),
    );
  }

  @Patch('roles/:id')
  @StaffRoute({ tenant: true, permission: 'roles.manage' })
  updateRole(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateRole(principal, id, parseInput(UpdateRoleRequest, body));
  }

  @Post('grants')
  @StaffRoute({ tenant: true, permission: 'grants.manage' })
  createGrant(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateGrantRequest, body);
    return this.idempotent(principal, 'createGrant', request, reply, input, () =>
      this.admin.createGrant(principal, input),
    );
  }

  @Post('grants/:id/revoke')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'grants.manage' })
  async revokeGrant(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { reason } = parseInput(RevokeGrantRequest, body ?? {});
    await this.admin.revokeGrant(principal, id, reason);
  }
}
