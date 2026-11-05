import { checkUrl } from '@hamnivo/adapters/net';
import {
  AgentConfig,
  type CreateA2AConnectionRequest,
  type Workflow,
  WorkflowDefinition,
  type WorkflowRun,
  WorkflowStepResult,
} from '@hamnivo/contracts';
import {
  appendAudit,
  type Db,
  fromPublicId,
  newId,
  schema,
  type TenantTx,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { isOpen } from '@hamnivo/domain';
import { TERMINAL_WORKFLOW_STATES, workflowProblems } from '@hamnivo/domain/workflows';
import { authorize, type StaffPrincipal } from '@hamnivo/policy';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, max } from 'drizzle-orm';
import type { z } from 'zod';
import { AppError } from '../common/app-error.js';
import type { AppConfig } from '../config.js';
import { EgressService } from '../developer/egress.service.js';
import { enforce } from '../identity/staff.guard.js';
import { InboxAccess } from '../inbox/access.js';
import { enqueueOutbox } from '../outbox/outbox.js';
import { RunsService } from '../runtime/runs.service.js';
import { APP_DB, CLOCK, type Clock, CONFIG } from '../tokens.js';
import { WORKFLOW_TOPIC } from './workflow-events.js';

type Row = typeof schema.workflows.$inferSelect;
type Run = typeof schema.workflowRuns.$inferSelect;
@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(APP_DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly access: InboxAccess,
    private readonly runs: RunsService,
    private readonly egress: EgressService,
  ) {}
  private tx<T>(principal: StaffPrincipal, work: (tx: TenantTx) => Promise<T>) {
    return withTenant(
      this.db,
      { tenantId: principal.tenantId, actorId: toPublicId('staff', principal.staffMemberId) },
      work,
    );
  }
  private id(kind: Parameters<typeof fromPublicId>[0], publicId: string) {
    try {
      return fromPublicId(kind, publicId);
    } catch {
      throw new AppError('NOT_FOUND');
    }
  }
  private async brand(tx: TenantTx, principal: StaffPrincipal, id: string, manage = false) {
    const [brand] = await tx
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, this.id('brand', id)));
    if (!brand) throw new AppError('NOT_FOUND');
    enforce(
      authorize(
        principal,
        manage ? 'automations.manage' : 'automations.read',
        { workspaceId: brand.workspaceId, brandId: brand.id },
        { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60000 },
      ),
    );
    return brand;
  }
  private async row(tx: TenantTx, p: StaffPrincipal, id: string, manage = false, lock = false) {
    const q = tx
      .select()
      .from(schema.workflows)
      .where(eq(schema.workflows.id, this.id('workflow', id)));
    const [r] = lock ? await q.for('update') : await q;
    if (!r) throw new AppError('NOT_FOUND');
    await this.brand(tx, p, toPublicId('brand', r.brandId), manage);
    return r;
  }
  private async view(tx: TenantTx, row: Row): Promise<Workflow> {
    const [v] = row.publishedVersionId
      ? await tx
          .select()
          .from(schema.workflowVersions)
          .where(eq(schema.workflowVersions.id, row.publishedVersionId))
      : [];
    const draft = WorkflowDefinition.parse(row.draft);
    return {
      id: toPublicId('workflow', row.id),
      brandId: toPublicId('brand', row.brandId),
      name: row.name,
      enabled: row.enabled,
      revision: row.revision,
      draft,
      published: v
        ? {
            version: v.version,
            name: v.name,
            definition: WorkflowDefinition.parse(v.definition),
            publishedAt: v.publishedAt.toISOString(),
          }
        : null,
      unpublishedChanges:
        !v || v.name !== row.name || JSON.stringify(v.definition) !== JSON.stringify(row.draft),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  private audit(
    tx: TenantTx,
    p: StaffPrincipal,
    id: string,
    action: string,
    data: Record<string, unknown> = {},
  ) {
    return appendAudit(tx, {
      actorType: 'staff',
      actorId: toPublicId('staff', p.staffMemberId),
      action,
      targetType: 'workflow',
      targetId: id,
      outcome: 'success',
      data,
    });
  }
  async list(p: StaffPrincipal, brandId: string) {
    return this.tx(p, async (tx) => {
      const b = await this.brand(tx, p, brandId);
      const rows = await tx
        .select()
        .from(schema.workflows)
        .where(eq(schema.workflows.brandId, b.id))
        .orderBy(asc(schema.workflows.createdAt));
      const items: Workflow[] = [];
      for (const row of rows) items.push(await this.view(tx, row));
      return { items };
    });
  }
  async get(p: StaffPrincipal, id: string) {
    return this.tx(p, async (tx) => this.view(tx, await this.row(tx, p, id)));
  }
  async create(
    p: StaffPrincipal,
    brandId: string,
    input: { name: string; definition: WorkflowDefinition },
  ) {
    return this.tx(p, async (tx) => {
      const b = await this.brand(tx, p, brandId, true);
      const [r] = await tx
        .insert(schema.workflows)
        .values({
          id: newId(),
          tenantId: p.tenantId,
          brandId: b.id,
          name: input.name,
          draft: input.definition,
        })
        .returning();
      if (!r) throw new Error('workflow insert failed');
      await this.audit(tx, p, toPublicId('workflow', r.id), 'workflow.created');
      return this.view(tx, r);
    });
  }
  async save(
    p: StaffPrincipal,
    id: string,
    input: { name: string; definition: WorkflowDefinition; revision: number },
  ) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id, true, true);
      this.revision(r, input.revision);
      const [saved] = await tx
        .update(schema.workflows)
        .set({
          name: input.name,
          draft: input.definition,
          revision: r.revision + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.workflows.id, r.id))
        .returning();
      await this.audit(tx, p, id, 'workflow.saved');
      return this.view(tx, saved!);
    });
  }
  private revision(r: Row, n: number) {
    if (r.revision !== n) throw new AppError('VERSION_CONFLICT');
  }
  private async check(tx: TenantTx, row: Row, def: WorkflowDefinition) {
    const problems = workflowProblems(def);
    if (problems.length)
      throw new AppError('VALIDATION_FAILED', {
        fields: problems.map((p) => ({
          path: p.stepId ? `definition.steps.${p.stepId}` : 'definition',
          message: p.code,
        })),
      });
    const [agent] = await tx
      .select()
      .from(schema.agentProfiles)
      .where(
        and(
          eq(schema.agentProfiles.id, this.id('agent', def.agentId)),
          eq(schema.agentProfiles.brandId, row.brandId),
          eq(schema.agentProfiles.status, 'active'),
        ),
      );
    if (!agent?.publishedVersionId)
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Choose a published coordinator agent of this brand.',
      });
    if (def.trigger.type !== 'manual' && !agent.isDefault)
      throw new AppError('VALIDATION_FAILED', {
        reason: 'automatic_coordinator_must_be_default',
        detail:
          'Automatic workflows use the brand’s active default agent as coordinator. Choose that agent or use a manual trigger.',
        fields: [
          {
            path: 'definition.agentId',
            message: 'Choose the brand’s active default reply agent for an automatic trigger.',
          },
        ],
      });
    const [version] = await tx
      .select()
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.id, agent.publishedVersionId));
    const config = AgentConfig.parse(version?.config);
    for (const id of def.allowedDelegateAgentIds) {
      const [specialist] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(
          and(
            eq(schema.agentProfiles.id, this.id('agent', id)),
            eq(schema.agentProfiles.brandId, row.brandId),
            eq(schema.agentProfiles.status, 'active'),
          ),
        );
      if (!specialist?.publishedVersionId)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Specialists must be published agents of the same brand.',
        });
    }
    for (const step of def.steps) {
      if (step.type === 'tool_action' || step.type === 'approval') {
        if (!config.tools.grants.some((g) => g.toolId === step.toolId))
          throw new AppError('VALIDATION_FAILED', {
            detail: 'A workflow can use only tools granted to its coordinator.',
          });
        const [tool] = await tx
          .select()
          .from(schema.toolDefinitions)
          .where(
            and(
              eq(schema.toolDefinitions.id, this.id('tool', step.toolId)),
              eq(schema.toolDefinitions.brandId, row.brandId),
              eq(schema.toolDefinitions.status, 'enabled'),
            ),
          );
        if (!tool)
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Choose an enabled tool of this brand.',
          });
      }
      if (step.type === 'delegate' && step.connectionId) {
        const [c] = await tx
          .select()
          .from(schema.a2aConnections)
          .where(
            and(
              eq(schema.a2aConnections.id, this.id('a2aConnection', step.connectionId)),
              eq(schema.a2aConnections.brandId, row.brandId),
              eq(schema.a2aConnections.enabled, true),
            ),
          );
        if (!c)
          throw new AppError('VALIDATION_FAILED', {
            detail: 'Choose an enabled specialist connection of this brand.',
          });
        checkUrl(c.endpoint, await this.egress.policyIn(tx));
      }
    }
  }
  async publish(p: StaffPrincipal, id: string, revision: number) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id, true, true);
      this.revision(r, revision);
      const def = WorkflowDefinition.parse(r.draft);
      await this.check(tx, r, def);
      const [last] = await tx
        .select({ n: max(schema.workflowVersions.version) })
        .from(schema.workflowVersions)
        .where(eq(schema.workflowVersions.workflowId, r.id));
      const versionId = newId();
      const n = (last?.n ?? 0) + 1;
      await tx.insert(schema.workflowVersions).values({
        id: versionId,
        tenantId: p.tenantId,
        workflowId: r.id,
        version: n,
        name: r.name,
        definition: def,
      });
      const [saved] = await tx
        .update(schema.workflows)
        .set({ publishedVersionId: versionId, updatedAt: this.clock() })
        .where(eq(schema.workflows.id, r.id))
        .returning();
      await this.audit(tx, p, id, 'workflow.published', { version: n });
      return this.view(tx, saved!);
    });
  }
  async setEnabled(p: StaffPrincipal, id: string, enabled: boolean) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id, true, true);
      const [saved] = await tx
        .update(schema.workflows)
        .set({ enabled, updatedAt: this.clock() })
        .where(eq(schema.workflows.id, r.id))
        .returning();
      await this.audit(tx, p, id, enabled ? 'workflow.enabled' : 'workflow.paused');
      return this.view(tx, saved!);
    });
  }
  async versions(p: StaffPrincipal, id: string) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id);
      const rows = await tx
        .select()
        .from(schema.workflowVersions)
        .where(eq(schema.workflowVersions.workflowId, r.id))
        .orderBy(desc(schema.workflowVersions.version));
      return {
        items: rows.map((v) => ({
          version: v.version,
          name: v.name,
          definition: WorkflowDefinition.parse(v.definition),
          publishedAt: v.publishedAt.toISOString(),
        })),
      };
    });
  }
  async restore(p: StaffPrincipal, id: string, version: number, revision: number) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id, true, true);
      this.revision(r, revision);
      const [v] = await tx
        .select()
        .from(schema.workflowVersions)
        .where(
          and(
            eq(schema.workflowVersions.workflowId, r.id),
            eq(schema.workflowVersions.version, version),
          ),
        );
      if (!v) throw new AppError('NOT_FOUND');
      const [saved] = await tx
        .update(schema.workflows)
        .set({
          draft: v.definition,
          name: v.name,
          revision: r.revision + 1,
          updatedAt: this.clock(),
        })
        .where(eq(schema.workflows.id, r.id))
        .returning();
      await this.audit(tx, p, id, 'workflow.restored', { version });
      return this.view(tx, saved!);
    });
  }
  async runView(tx: TenantTx, r: Run): Promise<WorkflowRun> {
    const [v] = await tx
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.id, r.versionId));
    const steps = await tx
      .select()
      .from(schema.workflowRunSteps)
      .where(eq(schema.workflowRunSteps.runId, r.id))
      .orderBy(asc(schema.workflowRunSteps.startedAt));
    return {
      id: toPublicId('workflowRun', r.id),
      workflowId: toPublicId('workflow', r.workflowId),
      version: v!.version,
      conversationId: toPublicId('conversation', r.conversationId),
      state: r.state,
      currentStepId: r.currentStepId,
      reason: r.reason,
      wakeAt: r.wakeAt?.toISOString() ?? null,
      stepsUsed: r.stepsUsed,
      delegationsUsed: r.delegationsUsed,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      steps: steps.map((s) => ({
        stepId: s.stepId,
        type: s.type,
        state: s.state,
        actionId: s.actionId ? toPublicId('action', s.actionId) : null,
        summary: s.summary,
        result: s.result ? WorkflowStepResult.parse(s.result) : null,
        startedAt: s.startedAt.toISOString(),
        finishedAt: s.finishedAt?.toISOString() ?? null,
      })),
    };
  }
  async listRuns(p: StaffPrincipal, id: string) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id);
      const rows = await tx
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.workflowId, r.id))
        .orderBy(desc(schema.workflowRuns.startedAt))
        .limit(50);
      const items: WorkflowRun[] = [];
      for (const row of rows) items.push(await this.runView(tx, row));
      return { items };
    });
  }
  async start(p: StaffPrincipal, id: string, input: { conversationId: string; eventKey: string }) {
    return this.tx(p, async (tx) => {
      const r = await this.row(tx, p, id, true, true);
      const found = await this.access.authorized(tx, p, input.conversationId, 'conversations.read');
      if (found.control.brandId !== r.brandId) throw new AppError('NOT_FOUND');
      const run = await this.startIn(tx, p.tenantId, r, found.control, input.eventKey, {
        event: 'manual',
      });
      await this.audit(tx, p, id, 'workflow.started', { run: toPublicId('workflowRun', run.id) });
      return this.runView(tx, run);
    });
  }
  async startIn(
    tx: TenantTx,
    tenantId: string,
    r: Row,
    control: typeof schema.conversationControls.$inferSelect,
    eventKey: string,
    facts: Record<string, unknown>,
  ): Promise<Run> {
    const [prior] = await tx
      .select()
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, r.id),
          eq(schema.workflowRuns.conversationId, control.id),
          eq(schema.workflowRuns.eventKey, eventKey),
        ),
      );
    if (prior) return prior;
    if (!r.enabled || !r.publishedVersionId)
      throw new AppError('VALIDATION_FAILED', { detail: 'Publish and enable the workflow first.' });
    if (control.ownerMode !== 'AI_ACTIVE')
      throw new AppError('OWNERSHIP_CHANGED', {
        detail: 'The AI must own this conversation to start a workflow.',
      });
    const [v] = await tx
      .select()
      .from(schema.workflowVersions)
      .where(eq(schema.workflowVersions.id, r.publishedVersionId));
    const def = WorkflowDefinition.parse(v?.definition);
    await this.check(tx, r, def);
    const [agent] = await tx
      .select()
      .from(schema.agentProfiles)
      .where(eq(schema.agentProfiles.id, this.id('agent', def.agentId)));
    if (!agent?.publishedVersionId) throw new AppError('VALIDATION_FAILED');
    const run = await this.runs.start(tx, {
      tenantId,
      conversationId: control.id,
      brandId: r.brandId,
      agentId: agent.id,
      agentVersionId: agent.publishedVersionId,
      triggerRef: `workflow:${r.id}:${eventKey}`,
      kind: 'guard',
      epoch: control.ownershipEpoch,
    });
    const specialistVersions: Record<string, string> = {};
    for (const agentId of def.allowedDelegateAgentIds) {
      const [specialist] = await tx
        .select()
        .from(schema.agentProfiles)
        .where(
          and(
            eq(schema.agentProfiles.id, this.id('agent', agentId)),
            eq(schema.agentProfiles.brandId, r.brandId),
          ),
        );
      if (specialist?.publishedVersionId)
        specialistVersions[agentId] = specialist.publishedVersionId;
    }
    const [brand] = await tx.select().from(schema.brands).where(eq(schema.brands.id, r.brandId));
    const [customer] = control.principalId
      ? await tx
          .select()
          .from(schema.customerPrincipals)
          .where(eq(schema.customerPrincipals.id, control.principalId))
      : [];
    const [inbox] = await tx
      .select()
      .from(schema.conversationInboxState)
      .where(eq(schema.conversationInboxState.conversationId, control.id));
    const [latestMessage] = await tx
      .select({ id: schema.messageLedger.id })
      .from(schema.messageLedger)
      .where(
        and(
          eq(schema.messageLedger.conversationId, control.id),
          eq(schema.messageLedger.senderKind, 'customer'),
          eq(schema.messageLedger.expectsReply, true),
        ),
      )
      .orderBy(desc(schema.messageLedger.createdAt))
      .limit(1);
    const triggerMatch = eventKey.match(
      /^(?:customer_message|chat_started|offline_message):message:([a-f0-9-]{36})$/,
    );
    const triggerLedgerId =
      facts.event === 'manual' ? (latestMessage?.id ?? null) : (triggerMatch?.[1] ?? null);
    const snapshot = {
      hours_open: brand?.businessHours ? isOpen(brand.businessHours, this.clock()) : null,
      signed_in: customer?.kind === 'verified',
      language: customer?.locale ?? null,
      tag: inbox?.labels ?? [],
      ...facts,
      _specialistVersions: specialistVersions,
      _triggerLedgerId: triggerLedgerId,
    };
    const id = newId();
    const [started] = await tx
      .insert(schema.workflowRuns)
      .values({
        id,
        tenantId,
        brandId: r.brandId,
        workflowId: r.id,
        versionId: v!.id,
        conversationId: control.id,
        runtimeRunId: run.id,
        agentId: agent.id,
        agentVersionId: agent.publishedVersionId,
        eventKey,
        epoch: control.ownershipEpoch,
        currentStepId: def.entry,
        facts: snapshot,
        deadline: new Date(this.clock().getTime() + def.budget.maxDurationSeconds * 1000),
      })
      .onConflictDoNothing()
      .returning();
    if (!started) throw new AppError('VERSION_CONFLICT');
    await enqueueOutbox(tx, tenantId, {
      topic: WORKFLOW_TOPIC,
      aggregateType: 'workflow_run',
      aggregateId: id,
      payload: { runId: id },
    });
    return started;
  }
  async cancel(p: StaffPrincipal, id: string) {
    return this.tx(p, async (tx) => {
      const [r] = await tx
        .select()
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.id, this.id('workflowRun', id)))
        .for('update');
      if (!r) throw new AppError('NOT_FOUND');
      await this.row(tx, p, toPublicId('workflow', r.workflowId), true);
      await this.access.authorized(
        tx,
        p,
        toPublicId('conversation', r.conversationId),
        'conversations.read',
      );
      if (TERMINAL_WORKFLOW_STATES.has(r.state)) return this.runView(tx, r);
      const now = this.clock();
      await tx
        .update(schema.actions)
        .set({ state: 'cancelled', reason: 'workflow_cancelled', updatedAt: now })
        .where(
          and(
            eq(schema.actions.runId, r.runtimeRunId),
            inArray(schema.actions.state, ['awaiting_approval', 'approved']),
          ),
        );
      await tx
        .update(schema.runs)
        .set({ cancelRequestedAt: now, cancelRequestedBy: p.staffMemberId })
        .where(eq(schema.runs.id, r.runtimeRunId));
      const [saved] = await tx
        .update(schema.workflowRuns)
        .set({
          state: 'cancelled',
          cancelRequestedAt: now,
          finishedAt: now,
          reason: 'cancel_requested',
          leaseToken: null,
          leaseUntil: null,
        })
        .where(eq(schema.workflowRuns.id, r.id))
        .returning();
      await this.runs.finish(tx, r.runtimeRunId, { outcome: 'cancelled', state: 'skipped' });
      await this.audit(tx, p, toPublicId('workflow', r.workflowId), 'workflow.cancelled', {
        run: id,
      });
      return this.runView(tx, saved!);
    });
  }
  private connectionView(c: typeof schema.a2aConnections.$inferSelect) {
    return {
      id: toPublicId('a2aConnection', c.id),
      brandId: toPublicId('brand', c.brandId),
      name: c.name,
      endpoint: c.endpoint,
      enabled: c.enabled,
      timeoutSeconds: c.timeoutSeconds,
      hasCredential: c.credentialSecretId !== null,
      protocolVersion: '1.0' as const,
    };
  }
  async connections(p: StaffPrincipal, id: string) {
    return this.tx(p, async (tx) => {
      const b = await this.brand(tx, p, id);
      return {
        items: (
          await tx
            .select()
            .from(schema.a2aConnections)
            .where(eq(schema.a2aConnections.brandId, b.id))
        ).map((c) => this.connectionView(c)),
      };
    });
  }
  async createConnection(
    p: StaffPrincipal,
    id: string,
    input: z.infer<typeof CreateA2AConnectionRequest>,
  ) {
    return this.tx(p, async (tx) => {
      const b = await this.brand(tx, p, id, true);
      checkUrl(input.endpoint, await this.egress.policyIn(tx));
      const endpoint = new URL(input.endpoint);
      if (endpoint.search || endpoint.hash)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Use an A2A base URL without query or fragment.',
        });
      const secretId = input.credentialSecretId
        ? this.id('secret', input.credentialSecretId)
        : null;
      if (secretId) {
        const [s] = await tx.select().from(schema.secrets).where(eq(schema.secrets.id, secretId));
        if (!s || s.revokedAt) throw new AppError('NOT_FOUND');
        enforce(
          authorize(
            p,
            'secrets.manage',
            {},
            { now: this.clock(), stepUpMaxAgeMs: this.config.STEP_UP_MAX_AGE_MINUTES * 60000 },
          ),
        );
      }
      const [c] = await tx
        .insert(schema.a2aConnections)
        .values({
          tenantId: p.tenantId,
          brandId: b.id,
          name: input.name,
          endpoint: input.endpoint,
          credentialSecretId: secretId,
          timeoutSeconds: input.timeoutSeconds,
        })
        .returning();
      await this.audit(tx, p, toPublicId('a2aConnection', c!.id), 'a2a.connection.created');
      return this.connectionView(c!);
    });
  }
  async enableConnection(p: StaffPrincipal, id: string, enabled: boolean) {
    return this.tx(p, async (tx) => {
      const [c] = await tx
        .select()
        .from(schema.a2aConnections)
        .where(eq(schema.a2aConnections.id, this.id('a2aConnection', id)))
        .for('update');
      if (!c) throw new AppError('NOT_FOUND');
      await this.brand(tx, p, toPublicId('brand', c.brandId), true);
      const [saved] = await tx
        .update(schema.a2aConnections)
        .set({ enabled, updatedAt: this.clock() })
        .where(eq(schema.a2aConnections.id, c.id))
        .returning();
      await this.audit(tx, p, id, 'a2a.connection.enabled', { enabled });
      return this.connectionView(saved!);
    });
  }
}
