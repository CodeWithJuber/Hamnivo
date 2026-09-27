import {
  AddDocumentRequest,
  AddDocumentVersionRequest,
  CreateKnowledgeSourceRequest,
  KnowledgeSearchRequest,
  knowledgeRoutes,
  UpdateKnowledgeSourceRequest,
} from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { KnowledgeService } from './knowledge.service.js';

@Controller('v1/admin/knowledge')
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async once<T>(
    principal: StaffPrincipal,
    request: FastifyRequest,
    reply: FastifyReply,
    route: string,
    body: unknown,
    status: number,
    work: () => Promise<T>,
  ) {
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${principal.staffMemberId}`,
        route,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body,
      },
      async () => ({ status, body: await work() }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Get('sources')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async listSources(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.knowledge.listSources(principal) };
  }

  @Post('sources')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  createSource(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateKnowledgeSourceRequest, body);
    return this.once(
      principal,
      request,
      reply,
      knowledgeRoutes.createKnowledgeSource.operationId,
      input,
      201,
      () => this.knowledge.createSource(principal, input),
    );
  }

  @Patch('sources/:sourceId')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  updateSource(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ) {
    return this.knowledge.updateSource(
      principal,
      sourceId,
      parseInput(UpdateKnowledgeSourceRequest, body),
    );
  }

  @Get('sources/:sourceId/documents')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async listDocuments(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
  ) {
    return { items: await this.knowledge.listDocuments(principal, sourceId) };
  }

  @Post('sources/:sourceId/documents')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  addDocument(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(AddDocumentRequest, body);
    return this.once(
      principal,
      request,
      reply,
      knowledgeRoutes.addKnowledgeDocument.operationId,
      { sourceId, ...input },
      202,
      () => this.knowledge.addDocument(principal, sourceId, input),
    );
  }

  @Get('documents/:documentId')
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  getDocument(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('documentId') documentId: string,
  ) {
    return this.knowledge.getDocument(principal, documentId);
  }

  @Post('documents/:documentId/versions')
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  addVersion(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('documentId') documentId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(AddDocumentVersionRequest, body);
    return this.once(
      principal,
      request,
      reply,
      knowledgeRoutes.addKnowledgeDocumentVersion.operationId,
      { documentId, ...input },
      202,
      () => this.knowledge.addVersion(principal, documentId, input),
    );
  }

  @Post('documents/:documentId/review')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  review(@CurrentPrincipal() principal: StaffPrincipal, @Param('documentId') documentId: string) {
    return this.knowledge.review(principal, documentId);
  }

  @Post('documents/:documentId/retire')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'knowledge.manage' })
  retire(@CurrentPrincipal() principal: StaffPrincipal, @Param('documentId') documentId: string) {
    return this.knowledge.retire(principal, documentId);
  }

  @Post('search')
  @HttpCode(200)
  @StaffRoute({ tenant: true, permission: 'knowledge.read' })
  async search(@CurrentPrincipal() principal: StaffPrincipal, @Body() body: unknown) {
    return {
      items: await this.knowledge.search(principal, parseInput(KnowledgeSearchRequest, body)),
    };
  }
}
