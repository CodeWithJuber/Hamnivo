import {
  CreateMerchantConnectionRequest,
  CreateRefundRequest,
  commerceAdminRoutes,
  RecordFulfillmentRequest,
  RejectRefundRequest,
  ResolveExceptionRequest,
  ShareCatalogRequest,
  UpdateMerchantConnectionRequest,
} from '@hamnivo/contracts';
import { toPublicId } from '@hamnivo/db';
import type { StaffPrincipal } from '@hamnivo/policy';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { IdempotencyService, validIdempotencyKey } from '../common/idempotency.service.js';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { CartsService } from './carts.service.js';
import { FinanceExceptionsService } from './exceptions.service.js';
import { MerchantsService } from './merchants.service.js';
import { NoStoreInterceptor } from './no-store.interceptor.js';
import { OrdersService } from './orders.service.js';
import { RefundsService } from './refunds.service.js';

/**
 * Studio commerce: merchant connections, orders, refunds with approval, finance exceptions and a
 * conversation's commerce (C01, C10, C12, C19, R07). Every action is authorized against the
 * record's brand with packages/policy and audited.
 */
@Controller()
@UseInterceptors(NoStoreInterceptor)
export class StaffCommerceController {
  constructor(
    private readonly merchants: MerchantsService,
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly exceptions: FinanceExceptionsService,
    private readonly carts: CartsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('v1/admin/commerce/merchants')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  async listMerchants(@CurrentPrincipal() principal: StaffPrincipal) {
    return { items: await this.merchants.list(principal) };
  }

  @Post('v1/admin/commerce/merchants')
  @StaffRoute({ tenant: true, permission: 'commerce.merchants.manage' })
  async createMerchant(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(CreateMerchantConnectionRequest, body);
    // Credentials never enter the stored idempotency record: only a fingerprint of the request.
    const { apiKey: _apiKey, webhookSecret: _webhookSecret, ...fingerprint } = input;
    const result = await this.idempotency.run(
      {
        tenantId: principal.tenantId,
        actor: `staff:${toPublicId('staff', principal.staffMemberId)}`,
        route: commerceAdminRoutes.createMerchantConnection.operationId,
        key: validIdempotencyKey(request.headers['idempotency-key']),
        body: {
          ...fingerprint,
          apiKey: Boolean(input.apiKey),
          webhookSecret: Boolean(input.webhookSecret),
        },
      },
      async () => ({ status: 201, body: await this.merchants.create(principal, input) }),
    );
    reply.status(result.status);
    if (result.replayed) reply.header('idempotent-replayed', 'true');
    return result.body;
  }

  @Patch('v1/admin/commerce/merchants/:merchantId')
  @StaffRoute({ tenant: true, permission: 'commerce.merchants.manage' })
  updateMerchant(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('merchantId') merchantId: string,
    @Body() body: unknown,
  ) {
    return this.merchants.update(
      principal,
      merchantId,
      parseInput(UpdateMerchantConnectionRequest, body),
    );
  }

  @Get('v1/admin/commerce/orders')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  async listOrders(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(commerceAdminRoutes.listOrders.query, query);
    return {
      items: await this.orders.list(principal, {
        limit: input.limit,
        ...(input.q ? { q: input.q } : {}),
        ...(input.needsAttention ? { needsAttention: input.needsAttention } : {}),
      }),
    };
  }

  @Get('v1/admin/commerce/orders/:orderId')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  getOrder(@CurrentPrincipal() principal: StaffPrincipal, @Param('orderId') orderId: string) {
    return this.orders.detail(principal, orderId);
  }

  @Post('v1/admin/commerce/orders/:orderId/refunds')
  @StaffRoute({ tenant: true, permission: 'commerce.refunds.request' })
  @HttpCode(201)
  requestRefund(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.refunds.request(principal, orderId, parseInput(CreateRefundRequest, body));
  }

  @Post('v1/admin/commerce/orders/:orderId/fulfillments')
  @StaffRoute({ tenant: true, permission: 'commerce.orders.manage' })
  @HttpCode(200)
  recordFulfillment(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    return this.orders.recordFulfillment(
      principal,
      orderId,
      parseInput(RecordFulfillmentRequest, body),
    );
  }

  @Post('v1/admin/commerce/refunds/:refundId/approve')
  @StaffRoute({ tenant: true, permission: 'commerce.refunds.approve' })
  @HttpCode(200)
  approveRefund(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('refundId') refundId: string,
  ) {
    return this.refunds.approve(principal, refundId);
  }

  @Post('v1/admin/commerce/refunds/:refundId/reject')
  @StaffRoute({ tenant: true, permission: 'commerce.refunds.approve' })
  @HttpCode(200)
  rejectRefund(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('refundId') refundId: string,
    @Body() body: unknown,
  ) {
    return this.refunds.reject(principal, refundId, parseInput(RejectRefundRequest, body).reason);
  }

  @Post('v1/admin/commerce/refunds/:refundId/refresh')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  @HttpCode(200)
  refreshRefund(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('refundId') refundId: string,
  ) {
    return this.refunds.refresh(principal, refundId);
  }

  @Get('v1/admin/commerce/exceptions')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  async listExceptions(@CurrentPrincipal() principal: StaffPrincipal, @Query() query: unknown) {
    const input = parseInput(commerceAdminRoutes.listFinanceExceptions.query, query);
    return { items: await this.exceptions.list(principal, input.state) };
  }

  @Post('v1/admin/commerce/exceptions/:exceptionId/check')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  @HttpCode(200)
  checkException(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('exceptionId') exceptionId: string,
  ) {
    return this.exceptions.check(principal, exceptionId);
  }

  @Post('v1/admin/commerce/exceptions/:exceptionId/resolve')
  @StaffRoute({ tenant: true, permission: 'commerce.exceptions.resolve' })
  @HttpCode(200)
  resolveException(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('exceptionId') exceptionId: string,
    @Body() body: unknown,
  ) {
    return this.exceptions.resolve(
      principal,
      exceptionId,
      parseInput(ResolveExceptionRequest, body),
    );
  }

  @Get('v1/conversations/:conversationId/commerce')
  @StaffRoute({ tenant: true, permission: 'commerce.read' })
  conversation(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
  ) {
    return this.orders.conversation(principal, conversationId);
  }

  @Post('v1/conversations/:conversationId/commerce/catalog')
  @StaffRoute({ tenant: true, permission: 'commerce.carts.manage' })
  @HttpCode(201)
  shareCatalog(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.carts.shareCatalog(
      principal,
      conversationId,
      parseInput(ShareCatalogRequest, body ?? {}),
    );
  }
}
