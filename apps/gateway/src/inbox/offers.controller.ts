import { DeclineOfferRequest, SetRoutingProfileRequest } from '@hamnivo/contracts';
import type { StaffPrincipal } from '@hamnivo/policy';
import { Body, Controller, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { parseInput } from '../common/validation.js';
import { CurrentPrincipal, StaffRoute } from '../identity/request-auth.js';
import { OffersService } from './offers.service.js';

/** Conversations offered to me (HNV-10-03): what is offered now, accept, decline with a reason. */
@Controller('v1/inbox/offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.offers.list(principal);
  }

  @Post(':offerId/accept')
  @StaffRoute({ tenant: true, permission: 'conversations.takeover' })
  @HttpCode(200)
  accept(@CurrentPrincipal() principal: StaffPrincipal, @Param('offerId') offerId: string) {
    return this.offers.accept(principal, offerId);
  }

  @Post(':offerId/decline')
  @StaffRoute({ tenant: true, permission: 'conversations.read' })
  @HttpCode(200)
  decline(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('offerId') offerId: string,
    @Body() body: unknown,
  ) {
    return this.offers.decline(principal, offerId, parseInput(DeclineOfferRequest, body));
  }
}

/** The languages each person answers in and how many open chats they take (HNV-10-03, H02). */
@Controller('v1/admin/routing-profiles')
export class RoutingProfilesController {
  constructor(private readonly offers: OffersService) {}

  @Get()
  @StaffRoute({ tenant: true, permission: 'members.read' })
  list(@CurrentPrincipal() principal: StaffPrincipal) {
    return this.offers.profiles(principal);
  }

  @Put(':staffMemberId')
  @StaffRoute({ tenant: true, permission: 'teams.manage' })
  set(
    @CurrentPrincipal() principal: StaffPrincipal,
    @Param('staffMemberId') staffMemberId: string,
    @Body() body: unknown,
  ) {
    return this.offers.setProfile(
      principal,
      staffMemberId,
      parseInput(SetRoutingProfileRequest, body),
    );
  }
}
