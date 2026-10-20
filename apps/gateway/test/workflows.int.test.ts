// biome-ignore-all lint/suspicious/noThenProperty: Workflow branch targets are strings, never promise callbacks.

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMockModel } from '@hamnivo/adapters/models';
import {
  type ClaimedOutboxEvent,
  fromPublicId,
  newId,
  schema,
  toPublicId,
  withTenant,
} from '@hamnivo/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowContextReader } from '../src/workflows/context-reader.service.js';
import { WorkflowRunner } from '../src/workflows/runner.service.js';
import { enrolTotp } from './access-support.js';
import { addTool, agentTools, demoStore } from './actions-support.js';
import { authority, customerStarts } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let rival: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let specialist: Server;
let specialistOrigin: string;
const externalRequests: { headers: Record<string, unknown>; body: Record<string, any> }[] = [];
const observedPrompts: string[] = [];
const baseModel = createMockModel();
const observedModel = {
  ...baseModel,
  async doGenerate(call: Parameters<typeof baseModel.doGenerate>[0]) {
    observedPrompts.push(JSON.stringify(call.prompt));
    return baseModel.doGenerate(call);
  },
};
let externalSlow = false;
let externalArrived: (() => void) | null = null;
beforeAll(async () => {
  specialist = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    externalRequests.push({
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    externalArrived?.();
    externalArrived = null;
    if (externalSlow) return; // Deliberately never responds: the real HTTP timeout must abort it.
    res.setHeader('content-type', 'application/a2a+json');
    res.end(
      JSON.stringify({
        message: {
          messageId: 'response',
          role: 'ROLE_AGENT',
          parts: [{ text: 'Private advisory response' }],
          grants: ['admin'],
        },
      }),
    );
  });
  await new Promise<void>((resolve) => specialist.listen(0, '127.0.0.1', resolve));
  specialistOrigin = `http://127.0.0.1:${(specialist.address() as AddressInfo).port}`;
  slice = await startSlice({
    model: observedModel,
    env: { EGRESS_TRUSTED_ORIGINS: specialistOrigin },
  });
  shop = await connectedTenant(slice, 'workflow');
  rival = await connectedTenant(slice, 'rival-workflow');
  tenantId = fromPublicId('tenant', shop.tenantId);
}, 120000);
afterAll(async () => {
  await slice?.close();
  specialist?.closeAllConnections();
  await new Promise<void>((resolve) => specialist?.close(() => resolve()));
});
const definition = (steps: unknown[]) => ({
  agentId: shop.agentId,
  trigger: { type: 'manual' },
  allowedDelegateAgentIds: [] as string[],
  entry: 'start',
  steps,
  budget: { maxSteps: 50, maxDelegations: 0, maxDurationSeconds: 3600, maxDepth: 0 },
});
async function create(steps: unknown[], publish = true) {
  const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
    name: 'Support workflow',
    definition: definition(steps),
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  if (publish) {
    const p = await shop.owner.post(`/v1/admin/workflows/${made.body.id}/publish`, { revision: 1 });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
  }
  return made.body.id as string;
}
async function chat() {
  const started = await customerStarts(slice, shop, 'Hello');
  await slice.drain();
  return started;
}
async function start(id: string, conversationId: string, eventKey: string = randomUUID()) {
  const response = await shop.owner.post(`/v1/admin/workflows/${id}/runs`, {
    conversationId,
    eventKey,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body;
}
async function read(id: string) {
  return (await shop.owner.get(`/v1/admin/workflows/${id}/runs`)).body.items;
}
async function tick(runId: string) {
  await slice.worker.get(WorkflowRunner).onEvent({
    tenantId,
    payload: { runId: fromPublicId('workflowRun', runId) },
  } as ClaimedOutboxEvent);
}
async function due(runId: string) {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.workflowRuns)
      .set({ wakeAt: new Date(0), leaseUntil: new Date(0) })
      .where(eq(schema.workflowRuns.id, fromPublicId('workflowRun', runId))),
  );
  await tick(runId);
}
async function resumeReply(conversationId: string) {
  const cid = fromPublicId('conversation', conversationId);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: new Date(0) })
      .where(
        and(
          eq(schema.outboxEvents.topic, 'conversation.customer_message'),
          eq(schema.outboxEvents.aggregateId, cid),
          isNull(schema.outboxEvents.processedAt),
        ),
      ),
  );
  await slice.drain();
}
describe('durable workflow execution', () => {
  it('keeps immutable published versions separate from revision-protected drafts', async () => {
    const id = await create([{ id: 'start', label: 'Trigger', type: 'trigger', next: null }]);
    const saved = await shop.owner.put(`/v1/admin/workflows/${id}`, {
      name: 'Changed',
      definition: definition([
        { id: 'start', label: 'Wait', type: 'wait', seconds: 30, next: null },
      ]),
      revision: 1,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.published.definition.steps[0].type).toBe('trigger');
    const stale = await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 });
    expect(stale.status).toBe(409);
    const restored = await shop.owner.post(`/v1/admin/workflows/${id}/versions/1/restore`, {
      revision: 2,
    });
    expect(restored.status).toBe(200);
    expect(restored.body.draft.steps[0].type).toBe('trigger');
    await expect(
      withTenant(slice.app, { tenantId }, (tx) =>
        tx
          .update(schema.workflowVersions)
          .set({ name: 'mutated' })
          .where(eq(schema.workflowVersions.workflowId, fromPublicId('workflow', id))),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/) } });
  });
  it('deduplicates duplicate events and concurrent worker deliveries', async () => {
    const id = await create([{ id: 'start', label: 'Trigger', type: 'trigger', next: null }]);
    const c = await chat();
    const first = await start(id, c.conversationId, 'duplicate-event');
    const second = await start(id, c.conversationId, 'duplicate-event');
    expect(first.id).toBe(second.id);
    await Promise.all([tick(first.id), tick(first.id)]);
    const rows = await read(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'completed', stepsUsed: 1 });
    expect(rows[0].steps).toHaveLength(1);
  });

  it('starts from the real customer event outbox and deduplicates replayed trigger delivery', async () => {
    const def = definition([{ id: 'start', label: 'Event received', type: 'trigger', next: null }]);
    def.trigger.type = 'customer_message';
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'Customer event',
      definition: def,
    });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(200);
    const c = await chat();
    const runs = await read(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].state).toBe('completed');
    const [ledger] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.messageLedger.id })
        .from(schema.messageLedger)
        .where(
          eq(schema.messageLedger.conversationId, fromPublicId('conversation', c.conversationId)),
        )
        .limit(1),
    );
    await slice.worker.get(WorkflowRunner).onTrigger({
      tenantId,
      payload: {
        conversationId: fromPublicId('conversation', c.conversationId),
        event: 'customer_message',
        ref: `message:${ledger!.id}`,
      },
    } as ClaimedOutboxEvent);
    expect(await read(id)).toHaveLength(1);
    await shop.owner.put(`/v1/admin/workflows/${id}/enabled`, { enabled: false });
  });
  it('uses current-message specialist evidence in the first coordinator reply with one publication', async () => {
    const def = definition([
      {
        id: 'start',
        label: 'Private current-message specialist',
        type: 'delegate',
        agentId: shop.agentId,
        request: 'Prepare private current-question support advice.',
        next: null,
      },
    ]);
    def.trigger.type = 'customer_message';
    def.allowedDelegateAgentIds = [shop.agentId];
    def.budget.maxDelegations = 1;
    def.budget.maxDepth = 1;
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'Specialist before reply',
      definition: def,
    });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(200);
    const promptsBefore = observedPrompts.length;
    const c = await chat();
    await resumeReply(c.conversationId);
    expect(
      observedPrompts
        .slice(promptsBefore)
        .some(
          (prompt) =>
            prompt.includes('Private workflow evidence follows') &&
            prompt.includes('local_specialist'),
        ),
    ).toBe(true);
    let seen = await authority(slice, shop, c.conversationId);
    expect(
      seen.messages.filter((message) => !message.private && message.direction === 'outgoing'),
    ).toHaveLength(1);
    const [ledger] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.messageLedger.id })
        .from(schema.messageLedger)
        .where(
          and(
            eq(schema.messageLedger.conversationId, seen.control.id),
            eq(schema.messageLedger.senderKind, 'customer'),
          ),
        )
        .limit(1),
    );
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx.insert(schema.outboxEvents).values({
        tenantId,
        topic: 'conversation.customer_message',
        aggregateType: 'conversation',
        aggregateId: seen.control.id,
        payload: {
          conversationId: seen.control.id,
          ledgerId: ledger!.id,
          epoch: seen.control.ownershipEpoch,
        },
      }),
    );
    await slice.drain();
    await resumeReply(c.conversationId);
    seen = await authority(slice, shop, c.conversationId);
    expect(
      seen.messages.filter((message) => !message.private && message.direction === 'outgoing'),
    ).toHaveLength(1);
    expect(await read(id)).toHaveLength(1);
    expect(
      await slice.worker.get(WorkflowRunner).prepareReply({
        tenantId,
        payload: {
          conversationId: seen.control.id,
          ledgerId: ledger!.id,
          epoch: seen.control.ownershipEpoch,
          workflowDeferrals: 30,
        },
      } as ClaimedOutboxEvent),
    ).toBe(false);
    await shop.owner.put(`/v1/admin/workflows/${id}/enabled`, { enabled: false });
  });
  it('handles a delayed workflow handoff before the first reply without duplicate publication', async () => {
    const def = definition([
      {
        id: 'start',
        label: 'Human review before reply',
        type: 'handoff',
        reason: 'A person needs to review this request.',
      },
    ]);
    def.trigger.type = 'customer_message';
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'Hand off before reply',
      definition: def,
    });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(200);
    const c = await chat();
    await resumeReply(c.conversationId);
    await resumeReply(c.conversationId);
    const seen = await authority(slice, shop, c.conversationId);
    expect(seen.control.ownerMode).toBe('WAITING_HUMAN');
    expect(
      seen.messages.filter((message) => !message.private && message.direction === 'outgoing'),
    ).toHaveLength(0);
    expect((await read(id))[0].state).toBe('handed_off');
    const pending = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.outboxEvents.id })
        .from(schema.outboxEvents)
        .where(
          and(
            eq(schema.outboxEvents.topic, 'conversation.customer_message'),
            eq(schema.outboxEvents.aggregateId, seen.control.id),
            isNull(schema.outboxEvents.processedAt),
          ),
        ),
    );
    expect(pending).toHaveLength(0);
    await shop.owner.put(`/v1/admin/workflows/${id}/enabled`, { enabled: false });
  });
  it('persists a wait and resumes only when its wake checkpoint is due', async () => {
    const id = await create([
      { id: 'start', label: 'Wait', type: 'wait', seconds: 120, next: 'finish' },
      { id: 'finish', label: 'Finish', type: 'trigger', next: null },
    ]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await tick(run.id);
    await tick(run.id);
    expect((await read(id))[0]).toMatchObject({ state: 'waiting', stepsUsed: 1 });
    await due(run.id);
    await tick(run.id);
    expect((await read(id))[0]).toMatchObject({ state: 'completed', stepsUsed: 2 });
  });
  it('recovers a checkpoint after process loss and leaves ambiguous delegation unknown', async () => {
    const id = await create([{ id: 'start', label: 'Trigger', type: 'trigger', next: null }]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await withTenant(slice.app, { tenantId }, async (tx) => {
      await tx
        .update(schema.workflowRuns)
        .set({ state: 'running', stepsUsed: 1, leaseToken: newId(), leaseUntil: new Date(0) })
        .where(eq(schema.workflowRuns.id, fromPublicId('workflowRun', run.id)));
      await tx.insert(schema.workflowRunSteps).values({
        tenantId,
        runId: fromPublicId('workflowRun', run.id),
        stepId: 'start',
        type: 'trigger',
        state: 'running',
      });
    });
    await tick(run.id);
    expect((await read(id))[0]).toMatchObject({ state: 'completed', stepsUsed: 1 });
  });
  it('stops after cancellation and after a human ownership epoch changes', async () => {
    const id = await create([
      { id: 'start', label: 'Wait', type: 'wait', seconds: 120, next: 'handoff' },
      { id: 'handoff', label: 'Hand off', type: 'handoff', reason: 'Escalate' },
    ]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await tick(run.id);
    const cancelled = await shop.owner.post(`/v1/admin/workflow-runs/${run.id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    await due(run.id);
    expect((await read(id))[0].state).toBe('cancelled');
    const other = await start(id, c.conversationId);
    await tick(other.id);
    const current = await shop.owner.get(`/v1/inbox/conversations/${c.conversationId}`);
    const takeover = await shop.owner.post(`/v1/inbox/conversations/${c.conversationId}/assign`, {
      to: { kind: 'me' },
      expectedEpoch: current.body.ownershipEpoch,
    });
    expect(takeover.status, JSON.stringify(takeover.body)).toBe(200);
    await due(other.id);
    expect((await read(id))[0]).toMatchObject({ state: 'cancelled', reason: 'owner_changed' });
  });
  it('routes handoff through existing ownership transitions', async () => {
    const id = await create([
      { id: 'start', label: 'Hand off', type: 'handoff', reason: 'A person needs to review this.' },
    ]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await tick(run.id);
    expect((await read(id))[0].state).toBe('handed_off');
    expect((await authority(slice, shop, c.conversationId)).control.ownerMode).toBe(
      'WAITING_HUMAN',
    );
  });
  it('keeps tenant data and cross-brand connections isolated', async () => {
    const id = await create([{ id: 'start', label: 'Trigger', type: 'trigger', next: null }]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    expect((await rival.owner.get(`/v1/admin/workflows/${id}`)).status).toBe(404);
    expect((await rival.owner.post(`/v1/admin/workflow-runs/${run.id}/cancel`, {})).status).toBe(
      404,
    );
    const foreign = await withTenant(
      slice.app,
      { tenantId: fromPublicId('tenant', rival.tenantId) },
      (tx) =>
        tx
          .select()
          .from(schema.workflowRuns)
          .where(eq(schema.workflowRuns.id, fromPublicId('workflowRun', run.id))),
    );
    expect(foreign).toHaveLength(0);
    expect(
      (
        await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/a2a-connections`, {
          name: 'Private host',
          endpoint: 'https://127.0.0.1',
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it('does not permit code or graph loops to publish', async () => {
    const id = await create(
      [{ id: 'start', label: 'Loop', type: 'trigger', next: 'start' }],
      false,
    );
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(422);
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'Code',
      definition: definition([{ id: 'start', label: 'Code', type: 'code', code: 'fetch(...)' }]),
    });
    expect(made.status).toBe(422);
  });
  it('waits for the existing bound approval and resumes after a receipt, without duplicate effects', async () => {
    const tool = await addTool(shop, 'demo_update_address');
    await agentTools(shop, [{ toolId: tool.id }]);
    const id = await create([
      {
        id: 'start',
        label: 'Approve exact address change',
        type: 'approval',
        toolId: tool.id,
        arguments: { orderReference: 'WF-9001', address: '7 Harbour Street, Dubai' },
        next: null,
      },
    ]);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await tick(run.id);
    await due(run.id);
    const waiting = (await read(id))[0];
    expect(waiting.state).toBe('awaiting_approval');
    const actions = await shop.owner.get(`/v1/inbox/conversations/${c.conversationId}/actions`);
    expect(actions.body.items).toHaveLength(1);
    const action = actions.body.items[0];
    const approved = await c.visitor.call(
      'POST',
      `/v1/widget/conversations/${c.conversationId}/actions/${action.id}/decision`,
      { decision: 'approve', argumentsHash: action.argumentsHash, clientRequestId: randomUUID() },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await slice.drain();
    await withTenant(slice.app, { tenantId }, async (tx) => {
      await tx
        .update(schema.workflowRunSteps)
        .set({ state: 'running', actionId: null })
        .where(eq(schema.workflowRunSteps.runId, fromPublicId('workflowRun', run.id)));
      await tx
        .update(schema.workflowRuns)
        .set({ state: 'running', leaseToken: newId(), leaseUntil: new Date(0), wakeAt: null })
        .where(eq(schema.workflowRuns.id, fromPublicId('workflowRun', run.id)));
    });
    await due(run.id);
    const finished = (await read(id))[0];
    expect(finished.state).toBe('completed');
    expect(finished.steps[0].actionId).toBe(action.id);
    expect(demoStore(shop).address('WF-9001').address).toBe('7 Harbour Street, Dubai');
    const after = await shop.owner.get(`/v1/inbox/conversations/${c.conversationId}/actions`);
    expect(after.body.items).toHaveLength(1);
    const operationId = after.body.items[0].operationId;
    expect(demoStore(shop).effects.get(`hv-action-${fromPublicId('operation', operationId)}`)).toBe(
      1,
    );
  });
  it('runs an explicitly allowed local specialist privately under the parent budget', async () => {
    const def = definition([
      {
        id: 'start',
        label: 'Ask privately',
        type: 'delegate',
        agentId: shop.agentId,
        request: 'Summarize public support guidance privately.',
        next: null,
      },
    ]);
    def.allowedDelegateAgentIds = [shop.agentId];
    def.budget.maxDelegations = 1;
    def.budget.maxDepth = 1;
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'Private specialist',
      definition: def,
    });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(200);
    const c = await chat();
    const before = await authority(slice, shop, c.conversationId);
    const run = await start(id, c.conversationId);
    await tick(run.id);
    const finished = (await read(id))[0];
    expect(finished).toMatchObject({ state: 'completed', delegationsUsed: 1, stepsUsed: 1 });
    const after = await authority(slice, shop, c.conversationId);
    expect(after.messages.filter((m) => !m.private)).toHaveLength(
      before.messages.filter((m) => !m.private).length,
    );
    const step = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.workflowRunSteps)
        .where(eq(schema.workflowRunSteps.runId, fromPublicId('workflowRun', run.id))),
    );
    expect(step[0]?.result).toMatchObject({
      source: 'local_specialist',
      trust: 'untrusted',
      agentId: shop.agentId,
    });
    const control = (await authority(slice, shop, c.conversationId)).control;
    const reader = slice.worker.get(WorkflowContextReader);
    const [ledger] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.messageLedger.id })
        .from(schema.messageLedger)
        .where(eq(schema.messageLedger.conversationId, control.id))
        .limit(1),
    );
    const context = await reader.context(tenantId, {
      conversationId: control.id,
      epoch: control.ownershipEpoch,
      agentId: fromPublicId('agent', shop.agentId),
      ledgerId: ledger!.id,
    });
    expect(context).toMatchObject({ untrusted: true });
    expect(context?.text).toContain('local_specialist');
    expect(
      await reader.context(tenantId, {
        conversationId: control.id,
        epoch: control.ownershipEpoch + 1,
        agentId: fromPublicId('agent', shop.agentId),
        ledgerId: ledger!.id,
      }),
    ).toBeNull();
    expect(
      await reader.context(fromPublicId('tenant', rival.tenantId), {
        conversationId: control.id,
        epoch: control.ownershipEpoch,
        agentId: fromPublicId('agent', shop.agentId),
        ledgerId: ledger!.id,
      }),
    ).toBeNull();
    const ownInput = {
      conversationId: control.id,
      epoch: control.ownershipEpoch,
      agentId: fromPublicId('agent', shop.agentId),
      ledgerId: ledger!.id,
    };
    expect(await reader.context(tenantId, { ...ownInput, ledgerId: newId() })).toBeNull();
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.workflowRunSteps)
        .set({ finishedAt: new Date(Date.now() - 61000) })
        .where(eq(schema.workflowRunSteps.runId, fromPublicId('workflowRun', run.id))),
    );
    expect(await reader.context(tenantId, ownInput)).toBeNull();
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.workflowRunSteps)
        .set({
          finishedAt: new Date(),
          result: {
            source: 'knowledge',
            trust: 'untrusted',
            passages: [
              {
                sourceId: toPublicId('source', newId()),
                documentId: toPublicId('document', newId()),
                versionId: newId(),
                text: 'No longer public or current',
              },
            ],
          },
        })
        .where(eq(schema.workflowRunSteps.runId, fromPublicId('workflowRun', run.id))),
    );
    expect(await reader.context(tenantId, ownInput)).toBeNull();
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.workflowRunSteps)
        .set({ result: { source: 'tool', trust: 'untrusted', summary: 'Old account balance' } })
        .where(eq(schema.workflowRunSteps.runId, fromPublicId('workflowRun', run.id))),
    );
    expect(await reader.context(tenantId, ownInput)).toBeNull();
  });
  it('uses guarded real HTTP delegation with one credential and minimal explicit context, and fails on timeout', async () => {
    shop.owner = (await enrolTotp(slice.gw, shop.owner, 'workflow-owner@example.com')).client;
    const secret = await shop.owner.post('/v1/admin/secrets', {
      kind: 'a2a',
      label: 'Specialist bearer',
      value: 'workflow-test-only-secret',
    });
    expect(secret.status).toBe(201);
    const connection = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/a2a-connections`, {
      name: 'Private support specialist',
      endpoint: specialistOrigin,
      credentialSecretId: secret.body.id,
      timeoutSeconds: 1,
    });
    expect(connection.status, JSON.stringify(connection.body)).toBe(201);
    expect(JSON.stringify(connection.body)).not.toContain('workflow-test-only-secret');
    const def = definition([
      {
        id: 'start',
        label: 'Ask external specialist',
        type: 'delegate',
        connectionId: connection.body.id,
        request: 'Summarize public support policy only.',
        next: 'check',
      },
      {
        id: 'check',
        label: 'Check private specialist result',
        type: 'branch',
        predicate: {
          field: 'result',
          source: { stepId: 'start', path: ['text'] },
          op: 'is',
          value: 'Private advisory response',
        },
        then: 'followup',
        otherwise: null,
      },
      {
        id: 'followup',
        label: 'Use previous result as explicit request',
        type: 'delegate',
        connectionId: connection.body.id,
        request: 'Fallback request',
        requestFrom: { stepId: 'start', path: ['text'] },
        next: null,
      },
    ]);
    def.budget.maxDelegations = 2;
    def.budget.maxDepth = 1;
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/workflows`, {
      name: 'External specialist',
      definition: def,
    });
    expect(made.status).toBe(201);
    const id = made.body.id;
    expect(
      (await shop.owner.post(`/v1/admin/workflows/${id}/publish`, { revision: 1 })).status,
    ).toBe(200);
    const c = await chat();
    const run = await start(id, c.conversationId);
    await tick(run.id);
    await tick(run.id);
    await tick(run.id);
    expect((await read(id))[0]).toMatchObject({
      state: 'completed',
      stepsUsed: 3,
      delegationsUsed: 2,
    });
    expect(externalRequests.at(-1)!.body.message.parts).toEqual([
      { text: 'Private advisory response' },
    ]);
    const request = externalRequests.at(-2)!;
    expect(request.headers.authorization).toBe('Bearer workflow-test-only-secret');
    expect(request.headers['a2a-version']).toBe('1.0');
    expect(request.body.message.parts).toEqual([{ text: 'Summarize public support policy only.' }]);
    expect(request.body.message.role).toBe('ROLE_USER');
    expect(JSON.stringify(request.body)).not.toContain(c.conversationId);
    expect(JSON.stringify(request.body)).not.toContain(shop.tenantId);
    const rivalConnection = await rival.owner.get(
      `/v1/admin/brands/${rival.brand.id}/a2a-connections`,
    );
    expect(rivalConnection.body.items).toHaveLength(0);
    const before = externalRequests.length;
    externalSlow = true;
    const timed = await start(id, c.conversationId);
    await tick(timed.id);
    externalSlow = false;
    expect((await read(id))[0]).toMatchObject({ state: 'failed', reason: 'a2a_timeout' });
    expect(externalRequests.length).toBe(before + 1);
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.a2aConnections)
        .set({ timeoutSeconds: 30 })
        .where(eq(schema.a2aConnections.id, fromPublicId('a2aConnection', connection.body.id))),
    );
    externalSlow = true;
    const stopped = await start(id, c.conversationId);
    const arrived = new Promise<void>((resolve) => {
      externalArrived = resolve;
    });
    const running = tick(stopped.id);
    await arrived;
    const kill = await shop.owner.post('/v1/admin/kill-switches', {
      scope: 'agent',
      targetId: shop.agentId,
      reason: 'Stop the in-flight specialist',
    });
    expect(kill.status, JSON.stringify(kill.body)).toBe(201);
    await running;
    externalSlow = false;
    expect((await read(id))[0]).toMatchObject({ state: 'cancelled', reason: 'kill_switch' });
  });
});
