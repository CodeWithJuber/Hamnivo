import { fromPublicId, schema, toPublicId, withTenant } from '@hamnivo/db';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthorityRegistry } from '../src/authority/registry.js';
import { join } from './inbox-support.js';
import { connectedTenant, type Slice, startSlice } from './slice-harness.js';

/**
 * Running channels (ADR 0013): the team hears when a channel stops working (A11), once it has
 * been down for 15 minutes, and again when it works; and a blocked sender on a channel (H20) is
 * never answered: each conversation is closed with a note, and nothing else follows.
 */

let slice: Slice;
let shop: Awaited<ReturnType<typeof connectedTenant>>;
let tenantId: string;
let inboxRef: number;
let channelId: string;
const ownerEmail = 'ops-owner@example.com';

beforeAll(async () => {
  slice = await startSlice();
  shop = await connectedTenant(slice, 'ops');
  tenantId = fromPublicId('tenant', shop.tenantId);
  inboxRef = slice.fake.createChannelInbox(shop.connection.accountId, {
    type: 'email',
    name: 'Support email',
    address: 'help@ops.example',
  }).id;
  const found = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
  channelId = found.body.items[0].id;
}, 120_000);

afterAll(async () => {
  await slice?.close();
});

const find = () => shop.owner.post(`/v1/admin/brands/${shop.brand.id}/channels/find`, {});
const healthMail = () =>
  slice.workerMailer.messages.filter((m) => m.template?.startsWith('channel.'));

/** The 15 minutes pass: the delayed health events come due, and the worker runs. */
async function fifteenMinutesLater() {
  await withTenant(slice.app, { tenantId }, (tx) =>
    tx
      .update(schema.outboxEvents)
      .set({ availableAt: sql`now() - interval '1 second'` })
      .where(eq(schema.outboxEvents.topic, 'channel.health')),
  );
  await slice.drain();
}

describe('channel health alerts (A11)', () => {
  let agent: Awaited<ReturnType<typeof join>>;

  it('emails the people who manage integrations once a channel has been down 15 minutes', async () => {
    agent = await join(slice, shop, 'Ayaan Agent', 'agent');
    slice.fake.setReauthorizationRequired(inboxRef, true);
    await find();
    await slice.drain();
    // Not yet: it may come back on its own.
    expect(healthMail()).toEqual([]);
    expect((await shop.owner.get('/v1/workspace/notices')).body.unhealthyChannels).toEqual([]);
    await fifteenMinutesLater();
    expect(healthMail()).toEqual([
      expect.objectContaining({
        to: ownerEmail,
        template: 'channel.unhealthy',
        subject: expect.stringContaining('Email channel needs attention'),
        text: expect.stringContaining(`/channels?brand=${shop.brand.id}`),
      }),
    ]);
    // Once per incident, however often the worker runs.
    await fifteenMinutesLater();
    await find();
    await slice.drain();
    expect(healthMail()).toHaveLength(1);
    const audit = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ action: schema.auditEvents.action })
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, channelId)),
    );
    expect(audit.map((a) => a.action)).toContain('channel.unhealthy');
  });

  it('shows a banner to them, and not to the rest of the team', async () => {
    // As if the check had found the problem 20 minutes ago.
    await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .update(schema.authorityInboxes)
        .set({
          health: sql`jsonb_set(${schema.authorityInboxes.health}, '{checkedAt}', to_jsonb((now() - interval '20 minutes')::text))`,
        })
        .where(eq(schema.authorityInboxes.id, fromPublicId('inbox', channelId))),
    );
    const notices = await shop.owner.get('/v1/workspace/notices');
    expect(notices.status, JSON.stringify(notices.body)).toBe(200);
    expect(notices.body.unhealthyChannels).toEqual([
      expect.objectContaining({
        id: channelId,
        brandId: shop.brand.id,
        brandName: expect.any(String),
        kind: 'email',
        name: 'Support email',
        address: 'help@ops.example',
        problem: expect.stringContaining('sign in'),
        since: expect.any(String),
      }),
    ]);
    const theirs = await agent.client.get('/v1/workspace/notices');
    expect(theirs.status).toBe(200);
    expect(theirs.body.unhealthyChannels).toEqual([]);
  });

  it('emails them again once it works, and the banner goes', async () => {
    slice.fake.setReauthorizationRequired(inboxRef, false);
    await find();
    await slice.drain();
    expect(healthMail().map((m) => m.template)).toEqual(['channel.unhealthy', 'channel.recovered']);
    expect(healthMail()[1]).toMatchObject({ to: ownerEmail });
    expect((await shop.owner.get('/v1/workspace/notices')).body.unhealthyChannels).toEqual([]);
  });

  it('tells nobody about a blip shorter than 15 minutes', async () => {
    slice.fake.setReauthorizationRequired(inboxRef, true);
    await find();
    slice.fake.setReauthorizationRequired(inboxRef, false);
    await find();
    await fifteenMinutesLater();
    expect(healthMail()).toHaveLength(2);
  });
});

describe('blocking a sender on a channel (H20)', () => {
  const controlOf = async (externalId: number) => {
    const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.conversationControls)
        .where(eq(schema.conversationControls.externalConversationId, externalId)),
    );
    return row as typeof schema.conversationControls.$inferSelect;
  };
  const authority = async () =>
    (
      await slice.worker
        .get(AuthorityRegistry)
        .get(tenantId, fromPublicId('connection', shop.connection.id))
    ).authority;
  const notes = async (externalId: number) =>
    (await (await authority()).listMessages(String(externalId), { view: 'staff' })).filter(
      (m) => m.private && m.text?.includes('this sender is blocked'),
    );
  const ticketOf = async (conversationId: string) => {
    const [row] = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select({ number: schema.conversationInboxState.ticketNumber })
        .from(schema.conversationInboxState)
        .where(eq(schema.conversationInboxState.conversationId, conversationId)),
    );
    return row?.number ?? null;
  };
  let automationId: string;
  let first: { conversationId: number; messageId: number };
  let blockId: string;

  it('blocks the sender of an email conversation by their address', async () => {
    const made = await shop.owner.post(`/v1/admin/brands/${shop.brand.id}/automations`, {
      name: 'Every chat is urgent',
      definition: {
        event: { type: 'chat_started', seconds: 0 },
        match: 'all',
        conditions: [],
        actions: [{ type: 'set_priority', priority: 'urgent' }],
      },
      publish: true,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    automationId = made.body.id;
    first = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'troll@spam.example',
      subject: 'Hello',
      content: 'Rude words.',
    });
    await slice.drain();
    const control = await controlOf(first.conversationId);
    const block = await shop.owner.post(
      `/v1/inbox/conversations/${toPublicId('conversation', control.id)}/block`,
      { reason: 'Abuse', duration: 'always' },
    );
    expect(block.status, JSON.stringify(block.body)).toBe(201);
    expect(block.body).toMatchObject({
      channel: { kind: 'email', address: 'troll@spam.example' },
      signedIn: false,
      active: true,
    });
    blockId = block.body.id;
    await slice.drain();
    const listed = await shop.owner.get('/v1/visitors/blocks');
    expect(listed.body.items[0]).toMatchObject({
      id: blockId,
      channel: { kind: 'email', address: 'troll@spam.example' },
    });
  });

  it('closes their next email with one note, and starts nothing else', async () => {
    const runsBefore = (await shop.owner.get(`/v1/admin/automations/${automationId}/runs`)).body
      .items.length;
    const again = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'troll@spam.example',
      subject: 'Another one',
      content: 'More rude words.',
      newConversation: true,
    });
    await slice.drain();
    await slice.drain();
    const control = await controlOf(again.conversationId);
    expect(control).toMatchObject({ ownerMode: 'WAITING_HUMAN', authorityStatus: 'resolved' });
    expect(await notes(again.conversationId)).toHaveLength(1);
    expect(await ticketOf(control.id)).toBeNull();
    const state = await (await authority()).getState(String(again.conversationId));
    expect(state.status).toBe('resolved');
    expect(state.teamRef ?? null).toBeNull();
    expect(state.priority ?? null).not.toBe('urgent');
    // No AI reply, and no automation ran.
    expect(
      slice.fake.outbound.filter(
        (o) => o.kind === 'channel_reply' && o.conversationId === again.conversationId,
      ),
    ).toEqual([]);
    expect(
      (await shop.owner.get(`/v1/admin/automations/${automationId}/runs`)).body.items,
    ).toHaveLength(runsBefore);
    // The message is kept for the record.
    const kept = await withTenant(slice.app, { tenantId }, (tx) =>
      tx
        .select()
        .from(schema.messageLedger)
        .where(
          and(
            eq(schema.messageLedger.conversationId, control.id),
            like(schema.messageLedger.sourceKey, 'hv1:x:%'),
          ),
        ),
    );
    expect(kept).toHaveLength(1);

    // Writing again starts a new conversation (Chatwoot reopens none it resolved); closed too.
    const third = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'troll@spam.example',
      content: 'Still here.',
    });
    expect(third.conversationId).not.toBe(again.conversationId);
    await slice.drain();
    await slice.drain();
    expect(await notes(third.conversationId)).toHaveLength(1);
    expect((await (await authority()).getState(String(third.conversationId))).status).toBe(
      'resolved',
    );
  });

  it('leaves other addresses alone', async () => {
    const other = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'friend@customer.example',
      content: 'Where is my order?',
      newConversation: true,
    });
    await slice.drain();
    const control = await controlOf(other.conversationId);
    expect(control.authorityStatus).toBe('open');
    expect(await notes(other.conversationId)).toEqual([]);
    expect(await ticketOf(control.id)).not.toBeNull();
  });

  it('answers them as before once the block is lifted', async () => {
    const lifted = await shop.owner.delete(`/v1/visitors/blocks/${blockId}`);
    expect(lifted.status, JSON.stringify(lifted.body)).toBe(200);
    const back = await slice.fake.receiveChannelMessage(inboxRef, {
      from: 'troll@spam.example',
      content: 'Sorry about before.',
      newConversation: true,
    });
    await slice.drain();
    const control = await controlOf(back.conversationId);
    expect(control.authorityStatus).toBe('open');
    expect(await notes(back.conversationId)).toEqual([]);
    expect(await ticketOf(control.id)).not.toBeNull();
  });
});
