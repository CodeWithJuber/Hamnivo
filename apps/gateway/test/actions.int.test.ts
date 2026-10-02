import { randomUUID } from 'node:crypto';
import { fromPublicId, schema, withTenant } from '@hamnivo/db';
import { actionCode } from '@hamnivo/domain/actions';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ActionExecutor } from '../src/actions/executor.service.js';
import { ActionsWorker } from '../src/actions/worker.service.js';
import { CommerceWorker } from '../src/commerce/worker.service.js';
import {
  actionAudits,
  actionsModel,
  actionsOf,
  addTool,
  agentTools,
  Customer,
  conversationView,
  demoStore,
  latestAction,
  makeChecksDue,
  runsWithSteps,
  setTool,
  until,
} from './actions-support.js';
import { join, type Shop } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice, Visitor } from './slice-harness.js';

/**
 * AI actions end to end (G08, G10, G13–G15, W16, X02, X03): the mock model proposes tool calls
 * from the customer's words, the gateway decides, customers and staff approve, the worker sends
 * approved actions once through the operation ledger, and receipts settle what happened. The
 * demo order service stands in for a merchant system; it counts how often each idempotency key
 * changed something.
 */

let offsetMs = 0;
const clock = () => new Date(Date.now() + offsetMs);
const MINUTE = 60_000;

const { model, hooks } = actionsModel();
let slice: Slice;
let shop: Shop;
let rival: Shop;
let tenantId: string;
let address: { id: string };
let credit: { id: string };
let identityKey: { kid: string; privateKey: CryptoKey };

const ADDRESS = 'demo_update_address';

function changeAddress(reference: string, to = '7 Harbour Street, Dubai') {
  return `Please change the delivery address of order ${reference} to ${to}`;
}

/** The internal id of a public id. */
const uuid = (kind: 'action' | 'operation' | 'run', publicId: string) =>
  fromPublicId(kind, publicId);

/** How often the demo service applied the change of an action (0 or 1). */
function effectsOf(action: { operationId: string | null }) {
  if (!action.operationId) return 0;
  return demoStore(shop).effects.get(`hv-action-${uuid('operation', action.operationId)}`) ?? 0;
}

async function chat(text: string): Promise<Customer> {
  const customer = await Customer.open(slice, shop);
  await customer.say(text);
  return customer;
}

/** A customer the website signed in (approvals that ask who they are). */
async function verifiedCustomer(): Promise<Customer> {
  const visitor = new Visitor(slice.baseUrl, shop.brand.widgetId, shop.hostOrigin);
  await visitor.open();
  const subject = `customer-${randomUUID().slice(0, 8)}`;
  const assertion = await new SignJWT({ name: 'Sara Noor', email: `${subject}@example.com` })
    .setProtectedHeader({ alg: 'ES256', kid: identityKey.kid })
    .setSubject(subject)
    .setAudience(shop.brand.widgetId)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomUUID())
    .sign(identityKey.privateKey);
  const identified = await visitor.call('POST', '/v1/widget/identity', { assertion });
  expect(identified.status, JSON.stringify(identified.body)).toBe(200);
  visitor.adopt(identified.body);
  return new Customer(slice, visitor);
}

async function staffDecide(
  client: Shop['owner'],
  conversationId: string,
  action: { id: string; argumentsHash: string },
  decision: 'approve' | 'decline' = 'approve',
) {
  return client.post(`/v1/inbox/conversations/${conversationId}/actions/${action.id}/decision`, {
    decision,
    argumentsHash: action.argumentsHash,
    clientRequestId: randomUUID(),
  });
}

beforeAll(async () => {
  slice = await startSlice({ clock, model, env: { TOOLS_MAX_PARALLEL: '2' } });
  shop = await connectedTenant(slice, 'acts');
  rival = await connectedTenant(slice, 'rivalacts');
  tenantId = fromPublicId('tenant', shop.tenantId);
  address = await addTool(shop, ADDRESS);
  // Approving a credit also needs the permission to manage orders (a per-tool requirement).
  credit = await addTool(shop, 'demo_issue_credit', {
    requiredPermission: 'commerce.orders.manage',
  });
  await agentTools(shop, [{ toolId: address.id }, { toolId: credit.id }]);

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  identityKey = { kid: `k-${randomUUID().slice(0, 8)}`, privateKey };
  const publicJwk = await exportJWK(publicKey);
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx.insert(schema.brandIdentityKeys).values({
      tenantId,
      brandId: fromPublicId('brand', shop.brand.id),
      kid: identityKey.kid,
      alg: 'ES256',
      publicJwk,
    }),
  );
});

afterAll(async () => {
  await slice?.close();
});

afterEach(() => {
  offsetMs = 0;
  hooks.plan = undefined;
  hooks.batch = null;
  hooks.replies = [];
  demoStore(shop).faults.clear();
  demoStore(shop).delays.clear();
});

describe('customer approvals (G13, W16)', () => {
  it('shows the exact change, runs it once after approval and posts a receipt', async () => {
    const customer = await chat(changeAddress('NL-2001'));
    const proposed = await latestAction(shop, customer.conversationId);
    expect(proposed).toMatchObject({
      state: 'awaiting_approval',
      approver: 'customer',
      risk: 'write',
      stepUp: false,
      tool: { name: ADDRESS },
      summary: 'Change the delivery address of order NL-2001 to 7 Harbour Street, Dubai',
      arguments: { orderReference: 'NL-2001', address: '7 Harbour Street, Dubai' },
    });
    expect(proposed.changes).toEqual([
      { field: 'Delivery address', from: expect.any(String), to: '7 Harbour Street, Dubai' },
    ]);
    expect(proposed.code).toBe(actionCode(proposed.id));
    expect(new Date(proposed.expiresAt).getTime() - Date.now()).toBeGreaterThan(29 * MINUTE);

    // The card and the reply say what will happen and that nothing has changed yet.
    let view = await conversationView(slice, shop, customer.conversationId);
    expect(view.cards.map((c) => c.type)).toEqual(['approval']);
    expect(view.cards[0]?.text).toContain('Approval needed: Change the delivery address');
    expect(view.cards[0]?.text).toContain(`APPROVE ${proposed.code}`);
    expect(view.replies.at(-1)).toContain('Nothing has changed yet');
    expect(effectsOf(proposed)).toBe(0);

    // The customer sees their request, without the raw arguments.
    const seen = await customer.action(proposed.id);
    expect(seen.status).toBe(200);
    expect(seen.body.summary).toBe(proposed.summary);
    expect(seen.body.arguments).toBeUndefined();

    // Approving something other than what was shown is refused and changes nothing.
    const tampered = await customer.decide({
      id: proposed.id,
      argumentsHash: proposed.argumentsHash.replace(/^./, (c: string) => (c === 'a' ? 'b' : 'a')),
    });
    expect(tampered.status).toBe(409);
    expect(tampered.body.code).toBe('APPROVAL_MISMATCH');
    expect((await customer.action(proposed.id)).body.state).toBe('awaiting_approval');

    const clientRequestId = randomUUID();
    const approved = await customer.decide(proposed, 'approve', { clientRequestId });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({
      state: 'approved',
      decision: { decision: 'approved', approverKind: 'customer' },
    });
    // A repeated tap returns the same decision.
    const repeated = await customer.decide(proposed, 'approve', { clientRequestId });
    expect(repeated.status).toBe(200);
    await slice.drain();

    const done = await latestAction(shop, customer.conversationId);
    expect(done).toMatchObject({
      state: 'completed',
      receipt: { outcome: 'succeeded', source: 'provider_api' },
      outcome: 'The delivery address of order NL-2001 is now 7 Harbour Street, Dubai.',
    });
    expect(effectsOf(done)).toBe(1);
    expect(demoStore(shop).address('NL-2001').address).toBe('7 Harbour Street, Dubai');
    view = await conversationView(slice, shop, customer.conversationId);
    expect(view.cards.map((c) => c.type)).toEqual(['approval', 'receipt']);
    expect(view.cards[1]?.text).toContain('is now 7 Harbour Street, Dubai');

    // Sending it again (a redelivered job) sends nothing.
    const again = await slice.worker
      .get(ActionExecutor)
      .execute(tenantId, uuid('action', done.id), {});
    expect(again.state).toBe('completed');
    expect(effectsOf(done)).toBe(1);

    const audits = (await actionAudits(slice, shop, done.id)).map((a) => a.action);
    expect(audits).toEqual([
      'ai.action.proposed',
      'ai.action.approval_refused',
      'ai.action.approved',
      'ai.action.dispatched',
      'ai.action.executed',
    ]);
    // Audit records hold hashes and names, never the arguments.
    const records = JSON.stringify(await actionAudits(slice, shop, done.id));
    expect(records).not.toContain('Harbour');
  });

  it('a decline changes nothing', async () => {
    const customer = await chat(changeAddress('NL-2101'));
    const proposed = await latestAction(shop, customer.conversationId);
    const declined = await customer.decide(proposed, 'decline');
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ state: 'declined', reason: 'The request was declined.' });
    await slice.drain();
    expect((await latestAction(shop, customer.conversationId)).state).toBe('declined');
    expect(demoStore(shop).address('NL-2101').address).not.toBe('7 Harbour Street, Dubai');
  });

  it('a customer can never approve what needs staff; staff need the permissions and a fresh sign-in', async () => {
    const customer = await chat('Please issue a store credit of 500 AED for order NL-3001');
    const proposed = await latestAction(shop, customer.conversationId);
    expect(proposed).toMatchObject({
      state: 'awaiting_approval',
      approver: 'staff',
      risk: 'money',
      stepUp: true,
      code: null,
      amount: { amountMinor: '500', currency: 'AED' },
    });
    const view = await conversationView(slice, shop, customer.conversationId);
    // Only customer approvals are posted as cards to the customer.
    expect(view.cards).toEqual([]);
    expect(view.replies.at(-1)).toContain('A team member has to approve it first');

    const byCustomer = await customer.decide(proposed);
    expect(byCustomer.status).toBe(403);
    expect(byCustomer.body.code).toBe('SCOPE_DENIED');

    const editor = await join(slice, shop, 'Kiran Editor', 'knowledge_editor');
    expect((await staffDecide(editor.client, customer.conversationId, proposed)).status).toBe(403);
    // A support agent may approve actions, but not one that needs order management.
    const agent = await join(slice, shop, 'Amal Agent', 'agent');
    const byAgent = await staffDecide(agent.client, customer.conversationId, proposed);
    expect(byAgent.status).toBe(403);
    expect(byAgent.body.code).toBe('SCOPE_DENIED');

    const supervisor = await join(slice, shop, 'Omar Supervisor', 'supervisor');
    offsetMs = 15 * MINUTE;
    const stale = await staffDecide(supervisor.client, customer.conversationId, proposed);
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('REAUTH_REQUIRED');
    offsetMs = 0;
    expect((await latestAction(shop, customer.conversationId)).state).toBe('awaiting_approval');
    expect(effectsOf(await latestAction(shop, customer.conversationId))).toBe(0);

    const approved = await staffDecide(supervisor.client, customer.conversationId, proposed);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.decision).toMatchObject({ decision: 'approved', approverKind: 'staff' });
    await slice.drain();
    const done = await latestAction(shop, customer.conversationId);
    expect(done.state).toBe('completed');
    expect(effectsOf(done)).toBe(1);

    const audits = await actionAudits(slice, shop, done.id);
    const refused = audits.filter((a) => a.action === 'ai.action.approval_refused');
    expect(refused.map((a) => (a.data as { reason: string }).reason)).toEqual(['staff_only']);
    const approval = audits.find((a) => a.action === 'ai.action.approved');
    expect(approval?.data).toMatchObject({ channel: 'inbox', stepUp: true, risk: 'money' });
  });

  it('keeps actions to their own conversation, customer and tenant', async () => {
    const customer = await chat(changeAddress('NL-3101'));
    const proposed = await latestAction(shop, customer.conversationId);

    // Another customer of the same shop.
    const stranger = await Customer.open(slice, shop);
    stranger.conversationId = customer.conversationId;
    expect((await stranger.action(proposed.id)).status).toBe(404);
    expect((await stranger.decide(proposed)).status).toBe(404);

    // Another tenant's staff and customers.
    const listed = await rival.owner.get(
      `/v1/inbox/conversations/${customer.conversationId}/actions`,
    );
    expect(listed.status).toBe(404);
    const foreign = await rival.owner.post(
      `/v1/inbox/conversations/${customer.conversationId}/actions/${proposed.id}/decision`,
      { decision: 'approve', argumentsHash: proposed.argumentsHash, clientRequestId: randomUUID() },
    );
    expect(foreign.status).toBe(404);
    const outsider = await Customer.open(slice, rival);
    outsider.conversationId = customer.conversationId;
    expect((await outsider.decide(proposed)).status).toBe(404);

    expect((await latestAction(shop, customer.conversationId)).state).toBe('awaiting_approval');
  });

  it('a change to the order or the tool after the proposal needs a new request (X02)', async () => {
    const customer = await chat(changeAddress('NL-3201'));
    const proposed = await latestAction(shop, customer.conversationId);
    // The order changed elsewhere after the customer saw the card.
    await demoStore(shop).updateAddress({
      reference: 'NL-3201',
      address: '1 Elsewhere Road',
      idempotencyKey: `external-${randomUUID()}`,
    });
    const refused = await customer.decide(proposed);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('APPROVAL_MISMATCH');
    expect(await latestAction(shop, customer.conversationId)).toMatchObject({
      state: 'superseded',
      reason: 'The details changed after this was proposed, so it needs a new request.',
    });
    expect(demoStore(shop).address('NL-3201').address).toBe('1 Elsewhere Road');

    // A policy change supersedes approvals still pending for the tool.
    await customer.say(changeAddress('NL-3202'));
    const second = await latestAction(shop, customer.conversationId);
    expect(second.state).toBe('awaiting_approval');
    await setTool(shop, address.id, { title: 'Change the delivery address' });
    expect(await latestAction(shop, customer.conversationId)).toMatchObject({
      state: 'superseded',
      reason: 'The tool changed after this was proposed, so it needs a new request.',
    });
    expect((await customer.decide(second)).status).toBe(409);
    expect(effectsOf(second)).toBe(0);

    // The agent may no longer use the tool: an approval given afterwards does not run it.
    await customer.say(changeAddress('NL-3203'));
    const third = await latestAction(shop, customer.conversationId);
    expect(third.state).toBe('awaiting_approval');
    await agentTools(shop, [{ toolId: credit.id }]);
    try {
      const late = await customer.decide(third);
      expect(late.status).toBe(409);
      expect(await latestAction(shop, customer.conversationId)).toMatchObject({
        state: 'superseded',
        reason: 'The AI may no longer use this tool, so the request was cancelled.',
      });
      await slice.drain();
      expect(effectsOf(third)).toBe(0);
      expect(demoStore(shop).address('NL-3203').address).not.toBe('7 Harbour Street, Dubai');
    } finally {
      await agentTools(shop, [{ toolId: address.id }, { toolId: credit.id }]);
    }
  });

  it('approves or declines by code where cards are not shown, and acknowledges it', async () => {
    const customer = await chat(changeAddress('NL-3301', '9 Palm Road'));
    const proposed = await latestAction(shop, customer.conversationId);
    const repliesBefore = (await conversationView(slice, shop, customer.conversationId)).replies;

    await customer.say(`APPROVE ${proposed.code}`);
    const done = await latestAction(shop, customer.conversationId);
    expect(done).toMatchObject({ state: 'completed', decision: { approverKind: 'customer' } });
    expect(effectsOf(done)).toBe(1);
    const view = await conversationView(slice, shop, customer.conversationId);
    // The code is a decision, not a question: no AI reply to it.
    expect(view.replies).toEqual(repliesBefore);
    expect(view.cards.map((c) => c.type)).toEqual(['approval', 'approval', 'receipt']);
    expect(view.cards[1]?.text).toBe(
      'Approved: Change the delivery address of order NL-3301 to 9 Palm Road. You will get a confirmation here when it is done.',
    );
    const runs = await runsWithSteps(shop, customer.conversationId);
    expect(runs.at(-1)).toMatchObject({ outcome: 'skipped' });
    expect(runs.at(-1)?.steps.map((s: { name: string }) => s.name)).toEqual(['text_approval']);
    const approval = (await actionAudits(slice, shop, done.id)).find(
      (a) => a.action === 'ai.action.approved',
    );
    expect(approval?.data).toMatchObject({ channel: 'text' });

    await customer.say(changeAddress('NL-3302', '9 Palm Road'));
    const next = await latestAction(shop, customer.conversationId);
    await customer.say(`decline ${next.code?.toLowerCase()}`);
    expect((await latestAction(shop, customer.conversationId)).state).toBe('declined');
    const declinedView = await conversationView(slice, shop, customer.conversationId);
    expect(declinedView.cards.at(-1)?.text).toBe(
      'Declined: Change the delivery address of order NL-3302 to 9 Palm Road. Nothing was changed.',
    );
    expect(effectsOf(next)).toBe(0);

    // A code that names no pending request of this customer is an ordinary message.
    const before = (await conversationView(slice, shop, customer.conversationId)).replies.length;
    await customer.say(`APPROVE ${next.code}`);
    expect((await conversationView(slice, shop, customer.conversationId)).replies.length).toBe(
      before + 1,
    );
  });

  it('expires approvals nobody gave in time', async () => {
    const customer = await chat(changeAddress('NL-3401'));
    const proposed = await latestAction(shop, customer.conversationId);
    // The worker's sweep, by its clock (customer approvals stay open for 30 minutes).
    offsetMs = 31 * MINUTE;
    expect(await slice.worker.get(ActionsWorker).drainOnce()).toBeGreaterThanOrEqual(1);
    offsetMs = 0;
    expect((await latestAction(shop, customer.conversationId)).state).toBe('expired');
    const late = await customer.decide(proposed);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('APPROVAL_EXPIRED');
    expect(effectsOf(proposed)).toBe(0);

    // A decision after the deadline, before any sweep, is refused the same way.
    await setTool(shop, address.id, { approvalMinutes: 1 });
    try {
      await customer.say(changeAddress('NL-3402'));
      const short = await latestAction(shop, customer.conversationId);
      expect(new Date(short.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(MINUTE);
      offsetMs = 2 * MINUTE;
      const refused = await customer.decide(short);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('APPROVAL_EXPIRED');
      offsetMs = 0;
      expect((await latestAction(shop, customer.conversationId)).state).toBe('expired');
    } finally {
      offsetMs = 0;
      await setTool(shop, address.id, { approvalMinutes: null });
    }
  });

  it('asks the customer to confirm who they are when the tool requires it', async () => {
    await setTool(shop, address.id, { customerStepUp: true });
    try {
      const anonymous = await chat(changeAddress('NL-3501'));
      const unverified = await latestAction(shop, anonymous.conversationId);
      expect(unverified).toMatchObject({ stepUp: true, code: null });
      const refused = await anonymous.decide(unverified);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('IDENTITY_REQUIRED');
      // Text codes cannot stand in for the identity check.
      await anonymous.say(`APPROVE ${actionCode(unverified.id)}`);
      expect((await latestAction(shop, anonymous.conversationId)).state).toBe('awaiting_approval');

      const verified = await verifiedCustomer();
      await verified.say(changeAddress('NL-3502'));
      const proposed = await latestAction(shop, verified.conversationId);
      offsetMs = 11 * MINUTE;
      expect((await verified.decide(proposed)).body.code).toBe('IDENTITY_REQUIRED');
      offsetMs = 0;
      const approved = await verified.decide(proposed);
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      await slice.drain();
      expect((await latestAction(shop, verified.conversationId)).state).toBe('completed');
    } finally {
      await setTool(shop, address.id, { customerStepUp: false });
    }
  });
});

describe('receipts and reconciliation (G14)', () => {
  it('a lost answer after the change applied ends with one effect, settled from the records', async () => {
    const customer = await chat(changeAddress('NL-4001'));
    const proposed = await latestAction(shop, customer.conversationId);
    demoStore(shop).faults.set('updateAddress', ['timeout_after']);
    expect((await customer.decide(proposed)).status).toBe(200);
    await slice.drain();

    const lost = await latestAction(shop, customer.conversationId);
    expect(lost).toMatchObject({ state: 'unknown', receipt: { outcome: 'unknown' } });
    expect(effectsOf(lost)).toBe(1);
    let view = await conversationView(slice, shop, customer.conversationId);
    expect(view.cards.at(-1)?.text).toContain('The result is not confirmed yet');

    // The ledger's worker checks with the tool's own records; nothing is sent again.
    await makeChecksDue(slice, shop);
    expect(await slice.worker.get(CommerceWorker).drainOnce()).toBeGreaterThanOrEqual(1);
    await slice.drain();
    const settled = await latestAction(shop, customer.conversationId);
    expect(settled).toMatchObject({
      state: 'completed',
      receipt: { outcome: 'succeeded', source: 'reconciler' },
    });
    expect(effectsOf(settled)).toBe(1);
    view = await conversationView(slice, shop, customer.conversationId);
    expect(view.cards.map((c) => c.type)).toEqual(['approval', 'receipt', 'receipt']);

    const tenant = fromPublicId('tenant', shop.tenantId);
    const receipts = await withTenant(slice.app, { tenantId: tenant }, (tx) =>
      tx
        .select()
        .from(schema.operationReceipts)
        .where(
          eq(
            schema.operationReceipts.operationId,
            uuid('operation', settled.operationId as string),
          ),
        ),
    );
    expect(receipts.map((r) => [r.kind, r.outcome]).sort()).toEqual(
      [
        ['dispatch', 'pending'],
        ['reconcile', 'succeeded'],
        ['response', 'unknown'],
      ].sort(),
    );
  });

  it('a person can ask for a check; a change that never applied ends as failed', async () => {
    const customer = await chat(changeAddress('NL-4101'));
    const proposed = await latestAction(shop, customer.conversationId);
    demoStore(shop).faults.set('updateAddress', ['timeout_before']);
    await customer.decide(proposed);
    await slice.drain();
    const lost = await latestAction(shop, customer.conversationId);
    expect(lost.state).toBe('unknown');

    const check = await shop.owner.post(
      `/v1/inbox/conversations/${customer.conversationId}/actions/${lost.id}/check`,
      {},
    );
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    await slice.drain();
    expect(await latestAction(shop, customer.conversationId)).toMatchObject({
      state: 'failed',
      receipt: { outcome: 'failed' },
      outcome: 'The change for order NL-4101 was not made.',
    });
    expect(effectsOf(lost)).toBe(0);
  });

  it('the AI says something was done only with a receipt', async () => {
    hooks.plan = () => null;
    hooks.replies = [
      "I've updated your delivery address.",
      'I cannot change it myself, but I can ask for your approval to change it.',
    ];
    const customer = await chat('My address is wrong, can you fix it?');
    const view = await conversationView(slice, shop, customer.conversationId);
    expect(view.replies).toEqual([
      'I cannot change it myself, but I can ask for your approval to change it.',
    ]);
    const [run] = await runsWithSteps(shop, customer.conversationId);
    const guard = run?.steps.filter((s: { name: string }) => s.name === 'action_claims');
    expect(guard.map((s: { status: string }) => s.status)).toEqual(['blocked']);
    expect(guard[0].detail).toMatchObject({ claims: ['action_completed'], completedChanges: 0 });
  });
});

describe('autopilot and limits (G15, X03)', () => {
  it('runs allowlisted low-risk tools within the conversation budget, then asks', async () => {
    await setTool(shop, address.id, { autopilot: true });
    await agentTools(shop, [{ toolId: address.id, autopilot: true }, { toolId: credit.id }], {
      maxAutopilotPerConversation: 1,
    });
    const customer = await chat(changeAddress('NL-5001', '3 Cedar Lane'));
    const first = await latestAction(shop, customer.conversationId);
    expect(first).toMatchObject({
      state: 'completed',
      decision: { decision: 'approved', approverKind: 'autopilot' },
      receipt: { outcome: 'succeeded' },
    });
    expect(effectsOf(first)).toBe(1);
    const view = await conversationView(slice, shop, customer.conversationId);
    expect(view.replies.at(-1)).toBe(
      'Done: The delivery address of order NL-5001 is now 3 Cedar Lane.',
    );
    // The run step records the decision with hashes, not the arguments.
    const [run] = await runsWithSteps(shop, customer.conversationId);
    const step = run?.steps.find((s: { kind: string }) => s.kind === 'tool');
    expect(step).toMatchObject({
      name: ADDRESS,
      status: 'ok',
      detail: { decision: 'execute', outcome: 'completed', actionId: first.id },
    });
    expect(JSON.stringify(run)).not.toContain('Cedar');

    // Money is never autopilot, whatever the grant says.
    await customer.say('Please issue a store credit of 200 AED for order NL-5001');
    expect(await latestAction(shop, customer.conversationId)).toMatchObject({
      state: 'awaiting_approval',
      approver: 'staff',
    });

    await customer.say(changeAddress('NL-5002', '3 Cedar Lane'));
    const second = await latestAction(shop, customer.conversationId);
    expect(second).toMatchObject({
      state: 'awaiting_approval',
      reason: 'This needs approval because the automatic limit was reached.',
    });
    expect(effectsOf(second)).toBe(0);
  });

  it('the tenant budget and the autopilot switch apply across conversations', async () => {
    const settings = await shop.owner.get('/v1/admin/action-settings');
    expect(settings.body).toMatchObject({ autopilotEnabled: true });
    const tightened = await shop.owner.put('/v1/admin/action-settings', {
      dailyAutopilotLimit: 1,
    });
    expect(tightened.status, JSON.stringify(tightened.body)).toBe(200);
    try {
      const customer = await chat(changeAddress('NL-5101', '3 Cedar Lane'));
      expect(await latestAction(shop, customer.conversationId)).toMatchObject({
        state: 'awaiting_approval',
        reason: 'This needs approval because the automatic limit was reached.',
      });
      await shop.owner.put('/v1/admin/action-settings', {
        dailyAutopilotLimit: 1000,
        autopilotEnabled: false,
      });
      const other = await chat(changeAddress('NL-5102', '3 Cedar Lane'));
      expect(await latestAction(shop, other.conversationId)).toMatchObject({
        state: 'awaiting_approval',
        reason: 'This needs approval first.',
      });
    } finally {
      await shop.owner.put('/v1/admin/action-settings', {
        dailyAutopilotLimit: 200,
        autopilotEnabled: true,
      });
    }
  });

  it('stops tool calls at the per-run limit', async () => {
    await agentTools(shop, [{ toolId: address.id, autopilot: true }], { maxCallsPerRun: 2 });
    const references = ['NL-5201', 'NL-5202', 'NL-5203'];
    let next = 0;
    hooks.plan = ({ turn }) =>
      turn.text.includes('three orders') && next < references.length
        ? {
            toolName: ADDRESS,
            input: { orderReference: references[next++], address: '5 Station Road' },
          }
        : null;
    const customer = await chat('Please move all three orders to 5 Station Road');
    const actions = await actionsOf(shop, customer.conversationId);
    expect(actions.map((a) => [a.arguments.orderReference, a.state]).reverse()).toEqual([
      ['NL-5201', 'completed'],
      ['NL-5202', 'completed'],
      ['NL-5203', 'denied'],
    ]);
    expect(actions[0]?.reason).toBe('The AI reached its limit of tool calls for this message.');
    expect(demoStore(shop).address('NL-5203').address).not.toBe('5 Station Road');
  });

  it('never runs more tool calls at once than allowed', async () => {
    await agentTools(shop, [{ toolId: address.id, autopilot: true }], {
      maxCallsPerRun: 4,
      maxAutopilotPerConversation: 10,
    });
    const store = demoStore(shop);
    store.delays.set('updateAddress', 150);
    store.peak = 0;
    hooks.plan = () => null;
    hooks.batch = ['NL-5301', 'NL-5302', 'NL-5303', 'NL-5304'].map((orderReference) => ({
      toolName: ADDRESS,
      input: { orderReference, address: '8 Station Road' },
    }));
    const customer = await chat('Please update these orders');
    const actions = await actionsOf(shop, customer.conversationId);
    expect(actions).toHaveLength(4);
    expect(actions.every((a) => a.state === 'completed')).toBe(true);
    // TOOLS_MAX_PARALLEL is 2 in this suite.
    expect(store.peak).toBe(2);
  });

  it('a kill switch stops a tool at once, also for approvals already given out', async () => {
    await setTool(shop, address.id, { autopilot: false });
    await agentTools(shop, [{ toolId: address.id }, { toolId: credit.id }]);
    const customer = await chat(changeAddress('NL-5401'));
    const pending = await latestAction(shop, customer.conversationId);
    const stopped = await shop.owner.post('/v1/admin/kill-switches', {
      scope: 'tool',
      targetId: address.id,
      reason: 'Address service under maintenance',
    });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(201);
    try {
      expect((await shop.owner.get(`/v1/admin/tools/${address.id}`)).body.stopped).toBe(true);
      const refused = await customer.decide(pending);
      expect(refused.status).toBe(409);
      expect((await latestAction(shop, customer.conversationId)).state).toBe('superseded');

      await customer.say(changeAddress('NL-5402'));
      expect(await latestAction(shop, customer.conversationId)).toMatchObject({
        state: 'denied',
        reason: 'Actions with this tool are stopped for now.',
      });
      expect(effectsOf(pending)).toBe(0);
    } finally {
      const cleared = await shop.owner.post(`/v1/admin/kill-switches/${stopped.body.id}/clear`, {});
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    }
  });
});

describe('stopping, takeover and handoff (G10)', () => {
  it('cancelling a run stops its tool call in flight; the outcome is checked, never resent', async () => {
    await setTool(shop, address.id, { autopilot: true });
    await agentTools(shop, [{ toolId: address.id, autopilot: true }]);
    demoStore(shop).delays.set('updateAddress', 8000);
    const customer = await Customer.open(slice, shop);
    await customer.send(changeAddress('NL-6001', '2 Slow Street'));
    const draining = slice.drain();
    const action = await until(async () => {
      const [found] = await actionsOf(shop, customer.conversationId);
      return found?.state === 'executing' ? found : null;
    });
    const cancelled = await shop.owner.post(`/v1/admin/runs/${action.runId}/cancel`, {});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const started = Date.now();
    await draining;
    expect(Date.now() - started).toBeLessThan(6000);

    const [run] = await runsWithSteps(shop, customer.conversationId);
    expect(run).toMatchObject({ outcome: 'cancelled' });
    expect((await conversationView(slice, shop, customer.conversationId)).replies).toEqual([]);
    // It may have reached the service before it was stopped: checked, not resent.
    const stopped = await until(async () => {
      const found = await latestAction(shop, customer.conversationId);
      return found.state === 'unknown' ? found : null;
    });
    await shop.owner.post(
      `/v1/inbox/conversations/${customer.conversationId}/actions/${stopped.id}/check`,
      {},
    );
    await slice.drain();
    expect((await latestAction(shop, customer.conversationId)).state).toBe('failed');
    expect(effectsOf(stopped)).toBe(0);
    expect(demoStore(shop).address('NL-6001').address).not.toBe('2 Slow Street');
  });

  it('a takeover supersedes pending approvals and hands what was sent to the new owner', async () => {
    await setTool(shop, address.id, { autopilot: false });
    await agentTools(shop, [{ toolId: address.id }]);
    const customer = await chat(changeAddress('NL-6101'));
    const sent = await latestAction(shop, customer.conversationId);
    demoStore(shop).faults.set('updateAddress', ['timeout_after']);
    await customer.decide(sent);
    await slice.drain();
    expect((await latestAction(shop, customer.conversationId)).state).toBe('unknown');
    await customer.say(changeAddress('NL-6102'));
    const pending = await latestAction(shop, customer.conversationId);
    expect(pending.state).toBe('awaiting_approval');

    const agent = await join(slice, shop, 'Lina Agent', 'agent');
    const taken = await agent.client.post(
      `/v1/conversations/${customer.conversationId}/takeover`,
      {},
    );
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    await slice.drain();

    const actions = await actionsOf(shop, customer.conversationId);
    expect(actions.find((a) => a.id === pending.id)).toMatchObject({
      state: 'superseded',
      reason: 'Someone else now handles this conversation, so the request was cancelled.',
    });
    expect((await customer.decide(pending)).status).toBe(409);
    const view = await conversationView(slice, shop, customer.conversationId);
    const note = view.notes.find((n) => n.includes('AI actions in progress'));
    expect(note).toContain('Change the delivery address of order NL-6101');
    expect(note).toContain('not confirmed yet');

    // The new owner checks it; the change applied once and the receipt is posted.
    const check = await agent.client.post(
      `/v1/inbox/conversations/${customer.conversationId}/actions/${sent.id}/check`,
      {},
    );
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    await slice.drain();
    const settled = (await actionsOf(shop, customer.conversationId)).find((a) => a.id === sent.id);
    expect(settled?.state).toBe('completed');
    expect(effectsOf(settled as { operationId: string })).toBe(1);
    expect(effectsOf(pending)).toBe(0);
  });

  it('a handoff note says why, what the AI did, what is pending and the facts it used', async () => {
    await setTool(shop, address.id, { autopilot: true });
    await agentTools(shop, [{ toolId: address.id, autopilot: true }, { toolId: credit.id }]);
    const customer = await chat(changeAddress('NL-6201', '4 Al Noor Street'));
    const changed = await latestAction(shop, customer.conversationId);
    expect(changed.state).toBe('completed');
    await customer.say('Please issue a store credit of 300 AED for order NL-6201');
    const waiting = await latestAction(shop, customer.conversationId);
    expect(waiting.state).toBe('awaiting_approval');

    await customer.say('I want to talk to a human please');
    const view = await conversationView(slice, shop, customer.conversationId);
    expect(view.control.ownerMode).toBe('WAITING_HUMAN');
    const note = view.notes.find((n) => n.startsWith('Handoff:'));
    expect(note).toContain('The customer asked to talk to a person');
    expect(note).toContain("Customer's latest request: “I want to talk to a human please”");
    expect(note).toContain('Pending actions and approvals:');
    expect(note).toContain('Issue a store credit of AED 3.00 for order NL-6201');
    expect(note).toContain('Customer facts:');
    expect(note).toContain('The delivery address of order NL-6201 is now 4 Al Noor Street.');

    const packets = await shop.owner.get(
      `/v1/inbox/conversations/${customer.conversationId}/handoff-packets`,
    );
    expect(packets.status).toBe(200);
    expect(packets.body.items).toHaveLength(1);
    expect(packets.body.items[0]).toMatchObject({
      reason: 'customer_request',
      request: 'I want to talk to a human please',
      attempts: [{ kind: 'decision', label: 'Customer request', outcome: 'asked for a person' }],
      pending: [{ actionId: waiting.id, state: 'superseded', approver: 'staff' }],
      facts: expect.arrayContaining([
        expect.objectContaining({
          label: expect.stringContaining('delivery address'),
          value: 'The delivery address of order NL-6201 is now 4 Al Noor Street.',
          source: expect.objectContaining({ kind: 'tool', ref: changed.id }),
        }),
      ]),
    });
    // Approvals are bound to the epoch: the handoff ended the pending one.
    expect((await latestAction(shop, customer.conversationId)).state).toBe('superseded');

    // The packet is staff-only.
    const leaked = await customer.visitor.call(
      'GET',
      `/v1/inbox/conversations/${customer.conversationId}/handoff-packets`,
    );
    expect(leaked.status).toBe(401);
  });
});

describe('isolation in the database', () => {
  it('another tenant sees none of these actions', async () => {
    const rivalTenant = fromPublicId('tenant', rival.tenantId);
    const seen = await withTenant(slice.app, { tenantId: rivalTenant }, (tx) =>
      tx.select().from(schema.actions),
    );
    expect(seen).toEqual([]);
    const mine = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ id: schema.actions.id })
        .from(schema.actions)
        .where(and(eq(schema.actions.tenantId, tenantId))),
    );
    expect(mine.length).toBeGreaterThan(0);
  });
});
