import {
  AssignRequest,
  BulkRequest,
  CopilotRequest,
  CreateSavedReplyRequest,
  CreateTeamRequest,
  DraftLane,
  InboxListQuery,
  InboxMessagesQuery,
  InboxSearchQuery,
  LinkRequest,
  MakeTicketRequest,
  PresenceUpdate,
  PriorityRequest,
  ReviewRequest,
  SaveDraftRequest,
  SavedRepliesQuery,
  SetFieldsRequest,
  SetTagsRequest,
  SetTeamMembersRequest,
  StatusRequest,
  TeamAssignRequest,
  TransferRequest,
  TranslateRequest,
  UpdateTeamRequest,
  UrgentQuery,
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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseInput } from '../common/validation.js';
import type { AuthSession } from '../identity/auth.factory.js';
import { CurrentPrincipal, CurrentSession, StaffRoute } from '../identity/request-auth.js';
import { AnnotationsService } from './annotations.service.js';
import { AssignmentService } from './assignment.service.js';
import { AssistService } from './assist.service.js';
import { BulkService } from './bulk.service.js';
import { CollaborationService } from './collaboration.service.js';
import { DraftsService } from './drafts.service.js';
import { InboxService } from './inbox.service.js';
import { InboxLiveService } from './live.service.js';
import { InboxMessagesService } from './messages.service.js';
import { StatusService } from './status.service.js';
import { TeamsService } from './teams.service.js';
import { TicketsService } from './tickets.service.js';

const Lane = z.object({ lane: DraftLane });
const Outgoing = z.object({ clientMessageId: z.uuid() });

/**
 * The staff inbox API (H01–H17). Routes need a tenant and `conversations.read` somewhere; each
 * service then checks the exact permission against the conversation's workspace, brand, inbox and
 * team, so a conversation outside the caller's grants is NOT_FOUND.
 */
@Controller('v1/inbox')
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly messages: InboxMessagesService,
    private readonly assignment: AssignmentService,
    private readonly status: StatusService,
    private readonly annotations: AnnotationsService,
    private readonly drafts: DraftsService,
    private readonly assist: AssistService,
    private readonly collaboration: CollaborationService,
    private readonly bulk: BulkService,
    private readonly live: InboxLiveService,
    private readonly tickets: TicketsService,
  ) {}

  @Get('conversations')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.inbox.list(principal, parseInput(InboxListQuery, query));
  }

  @Get('urgent')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  urgent(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.inbox.urgent(principal, parseInput(UrgentQuery, query));
  }

  @Get('search')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  search(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    return this.inbox.search(principal, parseInput(InboxSearchQuery, query));
  }

  @Get('events')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  async events(
    @CurrentPrincipal() principal: StaffPrincipal,
    @CurrentSession() session: AuthSession,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.live.stream(request, reply, session, principal);
  }

  @Post('bulk')
  @StaffRoute({ tenant: true, permission: 'conversations.bulk' })
  @HttpCode(200)
  bulkApply(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.bulk.apply(principal, parseInput(BulkRequest, body));
  }

  @Get('conversations/:conversationId')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  detail(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.inbox.detail(principal, id);
  }

  @Get('conversations/:conversationId/messages')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  listMessages(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Query() query: unknown,
  ) {
    return this.messages.list(principal, id, parseInput(InboxMessagesQuery, query));
  }

  @Post('conversations/:conversationId/assign')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  assign(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.assignment.assign(principal, id, parseInput(AssignRequest, body));
  }

  @Post('conversations/:conversationId/team')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  team(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.assignment.setTeam(principal, id, parseInput(TeamAssignRequest, body).teamId);
  }

  @Get('conversations/:conversationId/assignees')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  assignees(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.assignment.assignees(principal, id);
  }

  @Post('conversations/:conversationId/transfer-request')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(202)
  async transfer(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.assignment.requestTransfer(principal, id, parseInput(TransferRequest, body));
  }

  @Post('conversations/:conversationId/status')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  setStatus(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.status.set(principal, id, parseInput(StatusRequest, body));
  }

  @Post('conversations/:conversationId/ticket')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  makeTicket(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.tickets.make(principal, id, parseInput(MakeTicketRequest, body));
  }

  @Post('conversations/:conversationId/priority')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  setPriority(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.tickets.setPriority(principal, id, parseInput(PriorityRequest, body));
  }

  @Get('conversations/:conversationId/tags')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  tags(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.annotations.tags(principal, id);
  }

  @Put('conversations/:conversationId/tags')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  setTags(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.annotations.setTags(principal, id, parseInput(SetTagsRequest, body).labels);
  }

  @Get('conversations/:conversationId/fields')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  fields(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.annotations.fields(principal, id);
  }

  @Patch('conversations/:conversationId/fields')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  setFields(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.annotations.setFields(principal, id, parseInput(SetFieldsRequest, body).values);
  }

  @Get('conversations/:conversationId/saved-replies')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  savedReplies(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Query() query: unknown,
  ) {
    return this.annotations.savedReplies(principal, id, parseInput(SavedRepliesQuery, query).q);
  }

  @Post('conversations/:conversationId/saved-replies')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  createSavedReply(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.annotations.createSavedReply(
      principal,
      id,
      parseInput(CreateSavedReplyRequest, body),
    );
  }

  @Get('conversations/:conversationId/customer')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  customer(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.inbox.customer(principal, id);
  }

  @Get('conversations/:conversationId/drafts')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  getDrafts(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return this.drafts.get(principal, id);
  }

  @Put('conversations/:conversationId/drafts/:lane')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  saveDraft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { lane } = parseInput(Lane, params);
    return this.drafts.save(principal, id, lane, parseInput(SaveDraftRequest, body));
  }

  @Delete('conversations/:conversationId/drafts/:lane')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(204)
  async deleteDraft(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param() params: unknown,
  ): Promise<void> {
    await this.drafts.remove(principal, id, parseInput(Lane, params).lane);
  }

  @Delete('conversations/:conversationId/outgoing/:clientMessageId')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(204)
  async discardOutgoing(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param() params: unknown,
  ): Promise<void> {
    await this.drafts.discardOutgoing(principal, id, parseInput(Outgoing, params).clientMessageId);
  }

  @Post('conversations/:conversationId/presence')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  presence(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.live.presence(principal, id, parseInput(PresenceUpdate, body));
  }

  @Post('conversations/:conversationId/copilot')
  @StaffRoute({ tenant: true, permission: 'conversations.reply' })
  @HttpCode(200)
  copilot(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.assist.suggest(principal, id, parseInput(CopilotRequest, body).clientRequestId);
  }

  @Post('conversations/:conversationId/messages/:messageId/translation')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  translate(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ) {
    return this.assist.translate(
      principal,
      id,
      messageId,
      parseInput(TranslateRequest, body).targetLanguage,
    );
  }

  @Get('conversations/:conversationId/reviews')
  @StaffRoute({ tenant: true, permission: 'conversations.review' })
  async reviews(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
  ) {
    return { items: await this.collaboration.reviews(principal, id) };
  }

  @Post('conversations/:conversationId/reviews')
  @StaffRoute({ tenant: true, permission: 'conversations.review' })
  createReview(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.review(principal, id, parseInput(ReviewRequest, body));
  }

  @Get('conversations/:conversationId/links')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  async links(@CurrentPrincipal() principal: StaffPrincipal, @Param('conversationId') id: string) {
    return { items: await this.collaboration.links(principal, id) };
  }

  @Post('conversations/:conversationId/links')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  createLink(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Body() body: unknown,
  ) {
    return this.collaboration.link(principal, id, parseInput(LinkRequest, body));
  }

  @Delete('conversations/:conversationId/links/:linkId')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(204)
  async deleteLink(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') id: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    await this.collaboration.unlink(principal, id, linkId);
  }
}

@Controller('v1/admin/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'members.read' })
  async list(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.teams.list(principal) };
  }

  @Post()
  @StaffRoute({ tenant: true, permission: 'teams.manage' })
  create(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return this.teams.create(principal, parseInput(CreateTeamRequest, body));
  }

  @Patch(':teamId')
  @StaffRoute({ tenant: true, permission: 'teams.manage' })
  update(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ) {
    return this.teams.update(principal, teamId, parseInput(UpdateTeamRequest, body));
  }

  @Put(':teamId/members')
  @StaffRoute({ tenant: true, permission: 'teams.manage' })
  setMembers(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('teamId') teamId: string,
    @Body() body: unknown,
  ) {
    return this.teams.setMembers(
      principal,
      teamId,
      parseInput(SetTeamMembersRequest, body).staffMemberIds,
    );
  }
}
