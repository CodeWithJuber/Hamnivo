import {
  CreateGrantRequest,
  CreateInvitationRequest,
  CreateRoleRequest,
  RemoveMemberRequest,
  ReplaceGrantRequest,
  RevokeGrantRequest,
  RolePreviewRequest,
  UpdateMemberRequest,
  UpdateRoleRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
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
  permissions(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: this.admin.permissions(principal) };
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

  @Get('members/:id/offboarding')
  @StaffRoute({ tenant: true, permission: 'members.remove', tenantWide: true })
  offboarding(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    return this.admin.offboarding(principal, id);
  }

  @Post('members/:id/remove')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'members.remove', tenantWide: true })
  async removeMember(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { reason } = parseInput(RemoveMemberRequest, body ?? {});
    await this.admin.removeMember(principal, id, reason);
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

  @Post('invitations/:id/resend')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'members.invite' })
  resendInvitation(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    return this.admin.resendInvitation(principal, id);
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

  /** A preview changes nothing, so it needs roles.manage without a fresh sign-in. */
  @Post('roles/preview')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'members.read' })
  previewRole(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.admin.previewRole(principal, parseInput(RolePreviewRequest, body));
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

  @Delete('roles/:id')
  @HttpCode(204)
  @StaffRoute({ tenant: true, permission: 'roles.manage' })
  async archiveRole(@CurrentPrincipal() principal: StaffPrincipal, @Param('id') id: string) {
    await this.admin.archiveRole(principal, id);
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

  @Post('grants/:id/replace')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'grants.manage' })
  replaceGrant(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.admin.replaceGrant(principal, id, parseInput(ReplaceGrantRequest, body));
  }
}
