import { randomUUID } from 'node:crypto';
import type { LanguageModelV4, LanguageModelV4Content } from '@ai-sdk/provider';
import { createMockModel, type MockToolOptions, type ToolPlan } from '@hamnivo/adapters/models';
import { DemoActionsStore } from '@hamnivo/adapters/tools';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { asc, eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { authority, type Shop } from './inbox-support.js';
import { type Slice, Visitor } from './slice-harness.js';

/**
 * Test hooks on the deterministic mock model: a scripted tool planner, several tool calls in one
 * step (parallel calls), and scripted reply texts (to try the reply guards).
 */
export interface ModelHooks {
  plan: MockToolOptions['plan'];
  batch: ToolPlan[] | null;
  replies: string[];
  /** Name and description of every tool the model was offered, as it saw them. */
  offered: { name: string; description: string }[];
}

export function actionsModel(): { model: LanguageModelV4; hooks: ModelHooks } {
  const hooks: ModelHooks = { plan: undefined, batch: null, replies: [], offered: [] };
  const base = createMockModel({ tools: { plan: (input) => hooks.plan?.(input) } });
  const model: LanguageModelV4 = {
    ...base,
    async doGenerate(call) {
      for (const tool of call.tools ?? []) {
        if (tool.type === 'function') {
          hooks.offered.push({ name: tool.name, description: tool.description ?? '' });
        }
      }
      const result = await base.doGenerate(call);
      const batch = hooks.batch;
      if (batch && call.prompt.at(-1)?.role === 'user') {
        hooks.batch = null;
        const content: LanguageModelV4Content[] = batch.map((plan, index) => ({
          type: 'tool-call',
          toolCallId: `batch_${index}`,
          toolName: plan.toolName,
          input: JSON.stringify(plan.input),
        }));
        return { ...result, content, finishReason: { unified: 'tool-calls', raw: 'tool_calls' } };
      }
      const next = result.content.some((part) => part.type === 'text') && hooks.replies.shift();
      return next ? { ...result, content: [{ type: 'text', text: next }] } : result;
    },
  };
  return { model, hooks };
}

/** The demo order service of a shop (the worker and the API share it in tests). */
export function demoStore(shop: Shop): DemoActionsStore {
  return DemoActionsStore.get(
    `${fromPublicId('tenant', shop.tenantId)}:${fromPublicId('brand', shop.brand.id)}`,
  );
}

/** Adds a built-in tool to the shop's brand and returns it. */
export async function addTool(shop: Shop, builtin: string, policy: Record<string, unknown> = {}) {
  const created = await shop.owner.post('/v1/admin/tools', {
    brandId: shop.brand.id,
    builtin,
    ...policy,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body as { id: string; revision: number; name: string };
}

/** Changes a tool's policy (the revision rises). */
export async function setTool(shop: Shop, toolId: string, changes: Record<string, unknown>) {
  const current = await shop.owner.get(`/v1/admin/tools/${toolId}`);
  expect(current.status, JSON.stringify(current.body)).toBe(200);
  const updated = await shop.owner.patch(`/v1/admin/tools/${toolId}`, {
    expectedRevision: current.body.revision,
    ...changes,
  });
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  return updated.body;
}

export interface Grant {
  toolId: string;
  autopilot?: boolean;
}

/** Publishes the shop's agent with these tool grants and budgets. */
export async function agentTools(
  shop: Shop,
  grants: Grant[],
  limits: { maxCallsPerRun?: number; maxAutopilotPerConversation?: number } = {},
) {
  const saved = await saveDraftTools(shop, grants, limits);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await shop.owner.post(`/v1/admin/agents/${shop.agentId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return published.body;
}

export async function saveDraftTools(
  shop: Shop,
  grants: Grant[],
  limits: { maxCallsPerRun?: number; maxAutopilotPerConversation?: number } = {},
) {
  const detail = await shop.owner.get(`/v1/admin/agents/${shop.agentId}`);
  const config = detail.body.draft?.config ?? detail.body.published.config;
  return shop.owner.put(`/v1/admin/agents/${shop.agentId}/draft`, {
    config: {
      ...config,
      tools: {
        maxCallsPerRun: 4,
        maxAutopilotPerConversation: 5,
        ...limits,
        grants: grants.map((g) => ({ toolId: g.toolId, autopilot: g.autopilot ?? false })),
      },
    },
  });
}

/** A widget customer with one conversation. */
export class Customer {
  conversationId = '';
  constructor(
    readonly slice: Slice,
    readonly visitor: Visitor,
  ) {}

  static async open(slice: Slice, shop: Shop): Promise<Customer> {
    const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
    await visitor.open();
    return new Customer(slice, visitor);
  }

  /** Sends a message (starting the conversation first) without waiting for the worker. */
  async send(text: string) {
    if (!this.conversationId) {
      const started = await this.visitor.call('POST', '/v1/widget/conversations', {
        firstMessage: text,
        clientMessageId: randomUUID(),
      });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      this.conversationId = started.body.id;
      return;
    }
    const sent = await this.visitor.call(
      'POST',
      `/v1/widget/conversations/${this.conversationId}/messages`,
      { clientMessageId: randomUUID(), parts: [{ type: 'text', text }] },
    );
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
  }

  /** Sends a message and lets the worker finish. */
  async say(text: string) {
    await this.send(text);
    await this.slice.drain();
  }

  action(actionId: string) {
    return this.visitor.call(
      'GET',
      `/v1/widget/conversations/${this.conversationId}/actions/${actionId}`,
    );
  }

  decide(
    action: { id: string; argumentsHash: string },
    decision: 'approve' | 'decline' = 'approve',
    overrides: Record<string, unknown> = {},
  ) {
    return this.visitor.call(
      'POST',
      `/v1/widget/conversations/${this.conversationId}/actions/${action.id}/decision`,
      {
        decision,
        argumentsHash: action.argumentsHash,
        clientRequestId: randomUUID(),
        ...overrides,
      },
    );
  }
}

/** An action as the API returns it (the fields tests use, and the rest). */
export interface ActionItem {
  [field: string]: any;
  id: string;
  state: string;
  argumentsHash: string;
  operationId: string | null;
  runId: string | null;
  code: string | null;
}

/** The actions of a conversation, newest first, as staff see them. */
export async function actionsOf(shop: Shop, conversationId: string) {
  const listed = await shop.owner.get(`/v1/inbox/conversations/${conversationId}/actions`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  return listed.body.items as ActionItem[];
}

/** The newest action of a conversation. */
export async function latestAction(shop: Shop, conversationId: string) {
  const [action] = await actionsOf(shop, conversationId);
  if (!action) throw new Error('no action');
  return action;
}

/** What Chatwoot shows: AI replies, cards (with their kind) and private notes. */
export async function conversationView(slice: Slice, shop: Shop, conversationId: string) {
  const { messages, control } = await authority(slice, shop, conversationId);
  const cards = messages
    .filter((m) => m.key?.startsWith('hv1:c:'))
    .map((m) => ({
      type: (m.contentAttributes.hv as { card: { type: string } }).card.type,
      text: m.text ?? '',
      bot: m.sender.kind === 'bot' && !m.private,
    }));
  return {
    control,
    cards,
    replies: messages
      .filter((m) => m.sender.kind === 'bot' && !m.private && !m.key?.startsWith('hv1:c:'))
      .map((m) => m.text ?? ''),
    notes: messages.filter((m) => m.private).map((m) => m.text ?? ''),
  };
}

/** Runs of a conversation with their steps, oldest first. */
export async function runsWithSteps(shop: Shop, conversationId: string) {
  const listed = await shop.owner.get(`/v1/admin/runs?conversationId=${conversationId}`);
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  const runs = [];
  for (const run of [...listed.body.items].reverse()) {
    const full = await shop.owner.get(`/v1/admin/runs/${run.id}`);
    expect(full.status).toBe(200);
    runs.push(full.body as Record<string, any>);
  }
  return runs;
}

/** Audit actions recorded for one AI action, oldest first. */
export async function actionAudits(slice: Slice, shop: Shop, actionId: string) {
  const tenantId = fromPublicId('tenant', shop.tenantId);
  const rows = await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.targetId, actionId))
      .orderBy(asc(schema.auditEvents.occurredAt)),
  );
  return rows;
}

/** Makes every operation check due now (the worker leases by the database clock). */
export async function makeChecksDue(slice: Slice, shop: Shop) {
  const tenantId = fromPublicId('tenant', shop.tenantId);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.operations)
      .set({
        nextReconcileAt: sql`now() - interval '1 second'`,
        dispatchedAt: sql`now() - interval '1 minute'`,
      })
      .where(sql`${schema.operations.state} in ('dispatched', 'unknown')`),
  );
}

/** Polls until the condition holds (for work running concurrently with the test). */
export async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
