import {
  ApproveQuoteRequest,
  CatalogSearchRequest,
  RequestQuoteRequest,
  UpdateCartRequest,
} from '@hamnivo/contracts';

import { Body, Controller, Get, HttpCode, Param, Post, Req, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { parseInput } from '../common/validation.js';
import type { WidgetClaims } from '../widget/tokens.service.js';
import { CurrentWidget, WidgetRoute } from '../widget/widget.guard.js';
import { CartsService } from './carts.service.js';
import { CheckoutService } from './checkout.service.js';
import { NoStoreInterceptor } from './no-store.interceptor.js';
import { OrdersService } from './orders.service.js';

const SUPPORTED_LOCALES = new Set(['en', 'ar', 'hi', 'ur']);

/**
 * The customer's side of shopping in a conversation (C02–C06): catalog, cart, exact quote,
 * approval, the hosted payment page and the order. Prices, stock and order state are read live
 * and never cached (K06).
 */
@Controller('v1/widget/conversations/:conversationId/commerce')
@UseInterceptors(NoStoreInterceptor)
export class WidgetCommerceController {
  constructor(
    private readonly carts: CartsService,
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
  ) {}

  @Post('catalogs')
  @WidgetRoute()
  @HttpCode(201)
  searchCatalog(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(CatalogSearchRequest, body ?? {});
    return this.carts.searchCatalog(
      claims,
      conversationId,
      input.query ? { query: input.query } : {},
    );
  }

  @Get('catalogs/:catalogId')
  @WidgetRoute()
  getCatalog(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('catalogId') catalogId: string,
  ) {
    return this.carts.getCatalog(claims, conversationId, catalogId);
  }

  @Get('cart')
  @WidgetRoute()
  getCart(@CurrentWidget() claims: WidgetClaims, @Param('conversationId') conversationId: string) {
    return this.carts.getCart(claims, conversationId);
  }

  @Post('cart')
  @WidgetRoute()
  @HttpCode(200)
  updateCart(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    return this.carts.updateCart(claims, conversationId, parseInput(UpdateCartRequest, body));
  }

  @Post('cart/quote')
  @WidgetRoute()
  @HttpCode(201)
  requestQuote(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(RequestQuoteRequest, body);
    return this.carts.requestQuote(claims, conversationId, input.cartRevision);
  }

  @Get('quotes/:quoteId')
  @WidgetRoute()
  getQuote(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.checkout.getQuote(claims, conversationId, quoteId);
  }

  @Post('quotes/:quoteId/approve')
  @WidgetRoute()
  @HttpCode(200)
  approve(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('quoteId') quoteId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    const language = request.headers['accept-language']?.split(',')[0]?.split('-')[0] ?? null;
    const origin = request.headers.origin;
    return this.checkout.approve(
      claims,
      conversationId,
      quoteId,
      parseInput(ApproveQuoteRequest, body),
      {
        locale: language && SUPPORTED_LOCALES.has(language) ? language : null,
        origin: typeof origin === 'string' ? origin.slice(0, 200) : null,
      },
    );
  }

  @Get('purchases/:purchaseId')
  @WidgetRoute()
  getPurchase(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.checkout.getPurchase(claims, conversationId, purchaseId);
  }

  @Post('purchases/:purchaseId/refresh')
  @WidgetRoute()
  @HttpCode(200)
  refresh(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.checkout.refresh(claims, conversationId, purchaseId);
  }

  @Post('purchases/:purchaseId/cancel')
  @WidgetRoute()
  @HttpCode(200)
  cancel(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('purchaseId') purchaseId: string,
  ) {
    return this.checkout.cancel(claims, conversationId, purchaseId);
  }

  @Get('orders/:orderId')
  @WidgetRoute()
  getOrder(
    @CurrentWidget() claims: WidgetClaims,
    @Param('conversationId') conversationId: string,
    @Param('orderId') orderId: string,
  ) {
    return this.orders.customerOrder(claims, conversationId, orderId);
  }
}
