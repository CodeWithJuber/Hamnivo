import {
  AssignPlanRequest,
  CreateOperatorApiKeyRequest,
  SetPlatformSignupRequest,
  TenantStateRequest,
} from '@hamnivo/contracts';
import type { Db } from '@hamnivo/db';
import { fromPublicId, InvalidPublicIdError } from '@hamnivo/db';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { activePlans } from '../billing/plans.js';
import { AppError } from '../common/app-error.js';
import { parseInput } from '../common/validation.js';
import { CurrentOperator, type OperatorContext, PlatformRoute } from '../identity/request-auth.js';
import { APP_DB } from '../tokens.js';
import { OperatorKeysService } from './operator-keys.js';
import { SignupPolicy } from './signup.js';
import { TenantLifecycleService } from './tenant-lifecycle.js';

function tenantIdOf(publicId: string): string {
  try {
    return fromPublicId('tenant', publicId);
  } catch (error) {
    if (error instanceof InvalidPublicIdError) throw new AppError('NOT_FOUND');
    throw error;
  }
}

/**
 * Running the server as a SaaS from the platform console (A17): the sign-up switch, plans,
 * a tenant's plan, trial and usage, suspension, and the operator API keys of billing systems.
 */
@Controller('v1/platform')
export class SaasConsoleController {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly signup: SignupPolicy,
    private readonly lifecycle: TenantLifecycleService,
    private readonly keys: OperatorKeysService,
  ) {}

  @Get('signup')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  signupSettings() {
    return this.signup.platformView();
  }

  @Put('signup')
  @PlatformRoute({ permission: 'platform.settings.manage' })
  setSignup(@CurrentOperator() operator: OperatorContext, @Body() body: unknown) {
    const { open } = parseInput(SetPlatformSignupRequest, body);
    return this.signup.set(operator, open);
  }

  @Get('plans')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  async plans() {
    const plans = await activePlans(this.db);
    return {
      items: plans.map((plan) => ({
        key: plan.key,
        name: plan.name,
        currency: plan.currency,
        priceMinor: plan.priceMinor.toString(),
        limits: plan.limits,
        trialDays: plan.trialDays,
        stripePriceId: plan.stripePriceId,
      })),
    };
  }

  @Get('tenants/:id/billing')
  @PlatformRoute({ permission: 'platform.tenants.read' })
  billing(@Param('id') id: string) {
    return this.lifecycle.billing(tenantIdOf(id));
  }

  @Put('tenants/:id/plan')
  @PlatformRoute({ permission: 'platform.tenants.manage' })
  async assignPlan(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const tenantId = tenantIdOf(id);
    const input = parseInput(AssignPlanRequest, body);
    await this.lifecycle.assignPlan(tenantId, input.planKey, input.startTrial, {
      kind: 'operator',
      operator,
    });
    return this.lifecycle.billing(tenantId);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  @PlatformRoute({ permission: 'platform.tenants.manage' })
  async suspend(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const tenantId = tenantIdOf(id);
    const { reason } = parseInput(TenantStateRequest, body);
    await this.lifecycle.setStatus(tenantId, 'suspended', { kind: 'operator', operator }, reason);
    return this.lifecycle.billing(tenantId);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  @PlatformRoute({ permission: 'platform.tenants.manage' })
  async reactivate(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const tenantId = tenantIdOf(id);
    const { reason } = parseInput(TenantStateRequest, body);
    await this.lifecycle.setStatus(tenantId, 'active', { kind: 'operator', operator }, reason);
    return this.lifecycle.billing(tenantId);
  }

  @Get('operator-keys')
  @PlatformRoute({ permission: 'platform.settings.manage' })
  async operatorKeys() {
    return { items: await this.keys.list() };
  }

  @Post('operator-keys')
  @PlatformRoute({ permission: 'platform.settings.manage' })
  createOperatorKey(@CurrentOperator() operator: OperatorContext, @Body() body: unknown) {
    const { name } = parseInput(CreateOperatorApiKeyRequest, body);
    return this.keys.create(operator, name);
  }

  @Post('operator-keys/:id/revoke')
  @HttpCode(200)
  @PlatformRoute({ permission: 'platform.settings.manage' })
  revokeOperatorKey(@CurrentOperator() operator: OperatorContext, @Param('id') id: string) {
    return this.keys.revoke(operator, id);
  }
}
