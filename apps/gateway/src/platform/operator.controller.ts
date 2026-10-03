import {
  OperatorChangePlanRequest,
  OperatorCreateAccountRequest,
  OperatorReasonRequest,
} from '@hamnivo/contracts';
import type { Db } from '@hamnivo/db';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { activePlans } from '../billing/plans.js';
import { parseInput } from '../common/validation.js';
import { TenantsService } from '../identity/tenants.service.js';
import { APP_DB } from '../tokens.js';
import { CurrentOperatorKey, OperatorApiRoute, type OperatorKeyActor } from './operator-keys.js';
import { TenantLifecycleService } from './tenant-lifecycle.js';

/**
 * The operator API: what a billing system such as WHMCS calls to run workspaces it sells
 * (CreateAccount, SuspendAccount, UnsuspendAccount, TerminateAccount, ChangePackage). Every call
 * is safe to repeat: the external reference names one workspace, and a state or plan the
 * workspace already has changes nothing.
 */
@Controller('v1/operator')
export class OperatorApiController {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    private readonly tenants: TenantsService,
    private readonly lifecycle: TenantLifecycleService,
  ) {}

  @Get('ping')
  @OperatorApiRoute()
  async ping() {
    return { ok: true as const, plans: (await activePlans(this.db)).map((plan) => plan.key) };
  }

  @Post('accounts')
  @OperatorApiRoute()
  async create(
    @CurrentOperatorKey() key: OperatorKeyActor,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parseInput(OperatorCreateAccountRequest, body);
    const { tenantId, created } = await this.tenants.createForOperator(input, key.actor);
    reply.status(created ? 201 : 200);
    return this.lifecycle.account(tenantId);
  }

  @Get('accounts/:ref')
  @OperatorApiRoute()
  async get(@Param('ref') ref: string) {
    return this.lifecycle.account(await this.lifecycle.resolve(ref));
  }

  @Post('accounts/:ref/suspend')
  @HttpCode(200)
  @OperatorApiRoute()
  async suspend(
    @CurrentOperatorKey() key: OperatorKeyActor,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    const tenantId = await this.lifecycle.resolve(ref);
    const { reason } = parseInput(OperatorReasonRequest, body ?? {});
    await this.lifecycle.setStatus(tenantId, 'suspended', { kind: 'key', key }, reason);
    return this.lifecycle.account(tenantId);
  }

  @Post('accounts/:ref/unsuspend')
  @HttpCode(200)
  @OperatorApiRoute()
  async unsuspend(
    @CurrentOperatorKey() key: OperatorKeyActor,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    const tenantId = await this.lifecycle.resolve(ref);
    const { reason } = parseInput(OperatorReasonRequest, body ?? {});
    await this.lifecycle.setStatus(tenantId, 'active', { kind: 'key', key }, reason);
    return this.lifecycle.account(tenantId);
  }

  @Post('accounts/:ref/terminate')
  @HttpCode(200)
  @OperatorApiRoute()
  async terminate(
    @CurrentOperatorKey() key: OperatorKeyActor,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    const tenantId = await this.lifecycle.resolve(ref);
    const { reason } = parseInput(OperatorReasonRequest, body ?? {});
    await this.lifecycle.setStatus(tenantId, 'closing', { kind: 'key', key }, reason);
    return this.lifecycle.account(tenantId);
  }

  @Put('accounts/:ref/plan')
  @OperatorApiRoute()
  async changePlan(
    @CurrentOperatorKey() key: OperatorKeyActor,
    @Param('ref') ref: string,
    @Body() body: unknown,
  ) {
    const tenantId = await this.lifecycle.resolve(ref);
    const input = parseInput(OperatorChangePlanRequest, body);
    await this.lifecycle.assignPlan(tenantId, input.planKey, input.startTrial, {
      kind: 'key',
      key,
    });
    return this.lifecycle.account(tenantId);
  }
}
